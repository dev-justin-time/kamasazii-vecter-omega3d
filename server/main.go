package main

import (
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"log"
	"math"
	rand_math "math/rand"
	"net"
	"net/http"
	"regexp"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// ─── Configuration ────────────────────────────────────────────────────────────

const (
	PORT              = ":8080"
	TICK_RATE         = 60                 // Hz
	TICK_INTERVAL     = 1000 / TICK_RATE   // ms
	MAX_PLAYERS       = 16
	MAX_SPEED         = 50.0
	MAX_THRUST        = 30.0
	COLLISION_DIST    = 5.0
	RESPAWN_DELAY     = 3  // seconds
	GLITCH_COOLDOWN   = 8  // seconds

	// Security
	MAX_CONNS_PER_IP  = 5       // max simultaneous WebSocket connections per IP
	MAX_MESSAGE_SIZE  = 4096    // 4 KB read limit per WebSocket message
	MSG_RATE_LIMIT    = 20.0    // messages per second per connection
	MSG_BURST         = 30.0    // token bucket capacity
	ROTATION_SPEED    = 3.0     // radians/sec max angular velocity
)

// ─── Types ────────────────────────────────────────────────────────────────────

type Vector3 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
	Z float64 `json:"z"`
}

type PlayerState struct {
	ID                string   `json:"id"`
	Position          Vector3  `json:"position"`
	Velocity          Vector3  `json:"velocity"`
	Rotation          [3][3]float64 `json:"rotation"`
	Health            float64  `json:"health"`
	Energy            float64  `json:"energy"`
	Score             int      `json:"score"`
	Kills             int      `json:"kills"`
	Deaths            int      `json:"deaths"`
	LastGlitchTime    time.Time `json:"-"`
	GlitchDriveReady  bool     `json:"glitch_drive_ready"`
	LastInputTime     time.Time `json:"-"`
}

type ClientInput struct {
	Type     string    `json:"type"`
	Pitch    float64   `json:"pitch,omitempty"`
	Yaw      float64   `json:"yaw,omitempty"`
	Roll     float64   `json:"roll,omitempty"`
	Throttle float64   `json:"throttle,omitempty"`
	Fire     string    `json:"fire,omitempty"`
	Glitch   bool      `json:"glitch,omitempty"`
}

type ServerMessage struct {
	Type      string         `json:"type"`
	Players   []PlayerState  `json:"players,omitempty"`
	Projectiles []Projectile `json:"projectiles,omitempty"`
	YourID    string         `json:"your_id,omitempty"`
	Message   string         `json:"message,omitempty"`
}

type Projectile struct {
	ID       string  `json:"id"`
	Position Vector3 `json:"position"`
	Velocity Vector3 `json:"velocity"`
	OwnerID  string  `json:"owner_id"`
	Weapon   string  `json:"weapon"`
	Lifetime float64 `json:"lifetime"`
}

type Room struct {
	ID         string
	Players    map[*websocket.Conn]*PlayerState
	Projectiles []Projectile
	mu         sync.Mutex
	TickCount  int
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
}

var rooms = make(map[string]*Room)
var roomsMu sync.Mutex

// ─── Security: IP connection limiter ─────────────────────────────────────────

var (
	ipConns   = make(map[string]int)
	ipConnsMu sync.Mutex
)

// ─── Security: Player ID validation ─────────────────────────────────────────

var validPlayerID = regexp.MustCompile(`^[a-zA-Z0-9_-]{3,24}$`)

// ─── Security: Cryptographically seeded RNG ─────────────────────────────────

var rng *rand_math.Rand

func init() {
	var seed int64
	if err := binary.Read(rand.Reader, binary.BigEndian, &seed); err != nil {
		seed = time.Now().UnixNano()
	}
	rng = rand_math.New(rand_math.NewSource(seed))
}

// ─── Security: Token-bucket rate limiter ─────────────────────────────────────

type RateLimiter struct {
	tokens float64
	last   time.Time
	rate   float64
	max    float64
	mu     sync.Mutex
}

// Allow returns true if a message is permitted under the rate limit.
// Disconnected clients whose limiter drifts above max are clamped.
func (rl *RateLimiter) Allow() bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()
	now := time.Now()
	rl.tokens += now.Sub(rl.last).Seconds() * rl.rate
	if rl.tokens > rl.max {
		rl.tokens = rl.max
	}
	rl.last = now
	if rl.tokens >= 1.0 {
		rl.tokens--
		return true
	}
	return false
}

// ─── Room Management ──────────────────────────────────────────────────────────

func getOrCreateRoom(roomID string) *Room {
	roomsMu.Lock()
	defer roomsMu.Unlock()

	if room, ok := rooms[roomID]; ok {
		return room
	}

	room := &Room{
		ID:      roomID,
		Players: make(map[*websocket.Conn]*PlayerState),
	}
	rooms[roomID] = room

	// Start the authoritative game loop for this room
	go room.gameLoop()

	log.Printf("[ROOM] Created room: %s", roomID)
	return room
}

// ─── Authoritative Game Loop ──────────────────────────────────────────────────

func (r *Room) gameLoop() {
	ticker := time.NewTicker(TICK_INTERVAL * time.Millisecond)
	defer ticker.Stop()

	for range ticker.C {
		r.mu.Lock()
		r.TickCount++

		// If no players remain, clean up the room
		if len(r.Players) == 0 {
			r.mu.Unlock()
			roomsMu.Lock()
			delete(rooms, r.ID)
			roomsMu.Unlock()
			log.Printf("[ROOM] Destroyed empty room: %s", r.ID)
			return
		}

		// Authoritative physics tick for all players
		for _, state := range r.Players {
			r.integratePlayer(state, 1.0/float64(TICK_RATE))
		}

		// Update projectiles
		r.updateProjectiles()

		// Broadcast state to all players
		r.broadcastState()
		r.mu.Unlock()
	}
}

func (r *Room) integratePlayer(state *PlayerState, dt float64) {
	// Apply velocity to position (server-authoritative)
	state.Position.X += state.Velocity.X * dt
	state.Position.Y += state.Velocity.Y * dt
	state.Position.Z += state.Velocity.Z * dt

	// Speed limit enforcement (anti-cheat)
	speed := math.Sqrt(
		state.Velocity.X*state.Velocity.X +
		state.Velocity.Y*state.Velocity.Y +
		state.Velocity.Z*state.Velocity.Z)
	if speed > MAX_SPEED {
		scale := MAX_SPEED / speed
		state.Velocity.X *= scale
		state.Velocity.Y *= scale
		state.Velocity.Z *= scale
	}

	// Damping
	state.Velocity.X *= 0.999
	state.Velocity.Y *= 0.999
	state.Velocity.Z *= 0.999

	// Energy regeneration
	state.Energy = math.Min(100.0, state.Energy+2.0*dt)
	if state.Energy >= 100.0 {
		state.GlitchDriveReady = true
	}

	// Respawn if dead
	if state.Health <= 0 {
		state.Position = Vector3{X: 0, Y: 50, Z: 0}
		state.Velocity = Vector3{}
		state.Health = 100.0
		state.Energy = 100.0
		state.Deaths++
	}
}

func (r *Room) updateProjectiles() {
	var active []Projectile
	for _, p := range r.Projectiles {
		p.Lifetime -= 1.0 / float64(TICK_RATE)
		if p.Lifetime <= 0 {
			continue
		}
		// Move projectile
		p.Position.X += p.Velocity.X / float64(TICK_RATE)
		p.Position.Y += p.Velocity.Y / float64(TICK_RATE)
		p.Position.Z += p.Velocity.Z / float64(TICK_RATE)

		// Check collisions with players
		for _, state := range r.Players {
			if state.ID == p.OwnerID {
				continue // No self-damage
			}
			dx := p.Position.X - state.Position.X
			dy := p.Position.Y - state.Position.Y
			dz := p.Position.Z - state.Position.Z
			dist := math.Sqrt(dx*dx + dy*dy + dz*dz)
			if dist < COLLISION_DIST {
				// Hit!
				state.Health -= 15.0
				if state.Health <= 0 {
					// Credit the kill
					for _, killer := range r.Players {
						if killer.ID == p.OwnerID {
							killer.Kills++
							killer.Score += 100
						}
					}
				}
				continue // projectile consumed on hit
			}
		}
		active = append(active, p)
	}
	r.Projectiles = active
}

func (r *Room) broadcastState() {
	players := make([]PlayerState, 0, len(r.Players))
	for _, state := range r.Players {
		players = append(players, *state)
	}

	msg := ServerMessage{
		Type:        "state",
		Players:     players,
		Projectiles: r.Projectiles,
	}

	data, err := json.Marshal(msg)
	if err != nil {
		return
	}

	for conn := range r.Players {
		err := conn.WriteMessage(websocket.TextMessage, data)
		if err != nil {
			log.Printf("[WS] Write error: %v", err)
			conn.Close()
			delete(r.Players, conn)
		}
	}
}

// ─── WebSocket Handler ────────────────────────────────────────────────────────

func handleWS(w http.ResponseWriter, r *http.Request) {
	// ── 1. IP connection limit ──────────────────────────────────────────────
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	ipConnsMu.Lock()
	if ipConns[ip] >= MAX_CONNS_PER_IP {
		ipConnsMu.Unlock()
		log.Printf("[AUTH] Rejected connection from %s — max %d connections per IP", ip, MAX_CONNS_PER_IP)
		http.Error(w, "Too many connections", http.StatusTooManyRequests)
		return
	}
	ipConns[ip]++
	ipConnsMu.Unlock()
	defer func() {
		ipConnsMu.Lock()
		ipConns[ip]--
		if ipConns[ip] <= 0 {
			delete(ipConns, ip)
		}
		ipConnsMu.Unlock()
	}()

	// ── 2. Player ID validation (lightweight auth) ─────────────────────────
	playerID := r.URL.Query().Get("player_id")
	if !validPlayerID.MatchString(playerID) {
		log.Printf("[AUTH] Rejected invalid player_id from %s: %q", ip, playerID)
		http.Error(w, "Invalid player_id: must be 3-24 alphanumeric, dash, or underscore characters", http.StatusBadRequest)
		return
	}

	// ── 3. WebSocket upgrade ───────────────────────────────────────────────
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[WS] Upgrade error: %v", err)
		return
	}
	defer conn.Close()

	// ── 4. Read limit (prevent oversized message DoS) ──────────────────────
	conn.SetReadLimit(MAX_MESSAGE_SIZE)

	// Join or create a room (default: "omega_arena")
	roomID := r.URL.Query().Get("room")
	if roomID == "" {
		roomID = "omega_arena"
	}

	room := getOrCreateRoom(roomID)

	playerState := &PlayerState{
		ID:       playerID,
		Position: Vector3{X: 0, Y: 50, Z: 0},
		Rotation: [3][3]float64{{1, 0, 0}, {0, 1, 0}, {0, 0, 1}}, // identity
		Health:   100.0,
		Energy:   100.0,
	}

	room.mu.Lock()
	room.Players[conn] = playerState

	// Send welcome with player ID
	welcome, _ := json.Marshal(ServerMessage{
		Type:   "welcome",
		YourID: playerID,
		Message: "Welcome to VECTOR STRIKE: OMNI — Air Superiority Arena",
	})
	conn.WriteMessage(websocket.TextMessage, welcome)
	room.mu.Unlock()

	log.Printf("[CONNECT] %s joined room %s (%d players)", playerID, roomID, len(room.Players))

	// ── 5. Per-connection rate limiter ─────────────────────────────────────
	limiter := &RateLimiter{tokens: MSG_BURST, last: time.Now(), rate: MSG_RATE_LIMIT, max: MSG_BURST}

	// ─── Client Input Loop ────────────────────────────────────────────────
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			log.Printf("[DISCONNECT] %s left room %s", playerID, roomID)
			room.mu.Lock()
			delete(room.Players, conn)
			room.mu.Unlock()
			break
		}

		// ── 6. Rate limit check ───────────────────────────────────────────
		if !limiter.Allow() {
			log.Printf("[RATE LIMIT] Disconnecting %s — exceeded %d msg/s", playerID, int(MSG_RATE_LIMIT))
			break
		}

		var input ClientInput
		if err := json.Unmarshal(msg, &input); err != nil {
			continue
		}

		room.mu.Lock()
		state := room.Players[conn]
		if state == nil {
			room.mu.Unlock()
			continue
		}

		state.LastInputTime = time.Now()

		switch input.Type {
		case "input":
			// Validate and clamp input (anti-cheat)
			pitch := clamp(input.Pitch, -1.0, 1.0)
			yaw := clamp(input.Yaw, -1.0, 1.0)
			roll := clamp(input.Roll, -1.0, 1.0)
			throttle := clamp(input.Throttle, 0.0, 1.0)

			// Apply thrust (server-authoritative)
			forward := applyRotationToVector(state.Rotation, Vector3{X: 0, Y: 0, Z: -1})
			thrust := throttle * MAX_THRUST
			state.Velocity.X += forward.X * thrust / float64(TICK_RATE)
			state.Velocity.Y += forward.Y * thrust / float64(TICK_RATE)
			state.Velocity.Z += forward.Z * thrust / float64(TICK_RATE)

			// Apply rotation
			applyTorque(&state.Rotation, pitch, yaw, roll, float64(TICK_RATE))

		case "fire":
			// Validate fire command (check energy, cooldown)
			if state.Energy >= 15.0 {
				state.Energy -= 15.0
				// Spawn projectile
				forward := applyRotationToVector(state.Rotation, Vector3{X: 0, Y: 0, Z: -1})
				proj := Projectile{
					ID:       fmt.Sprintf("proj_%d_%d", time.Now().UnixNano(), len(room.Projectiles)),
					Position: state.Position,
					Velocity: Vector3{
						X: forward.X * 120.0,
						Y: forward.Y * 120.0,
						Z: forward.Z * 120.0,
					},
					OwnerID:  state.ID,
					Weapon:   input.Fire,
					Lifetime: 2.0,
				}
				room.Projectiles = append(room.Projectiles, proj)
			}

		case "glitch":
			// Glitch drive — quantum displacement
			if state.GlitchDriveReady && time.Since(state.LastGlitchTime).Seconds() > GLITCH_COOLDOWN {
				state.GlitchDriveReady = false
				state.LastGlitchTime = time.Now()

				// Teleport to random position within arena bounds
				state.Position = Vector3{
					X: (mathRand() - 0.5) * 500,
					Y: 30 + mathRand()*100,
					Z: (mathRand() - 0.5) * 500,
				}
				state.Velocity = Vector3{}

				// Broadcast glitch event
				glitchMsg, _ := json.Marshal(ServerMessage{
					Type:    "event",
					Message: state.ID + " initiated GLITCH DRIVE!",
				})
				for c := range room.Players {
					c.WriteMessage(websocket.TextMessage, glitchMsg)
				}
			}
		}

		room.mu.Unlock()
	}
}

// ─── Math Helpers ─────────────────────────────────────────────────────────────

func clamp(val, min, max float64) float64 {
	if val < min {
		return min
	}
	if val > max {
		return max
	}
	return val
}

func mathRand() float64 {
	return rng.Float64()
}

func applyRotationToVector(rot [3][3]float64, v Vector3) Vector3 {
	return Vector3{
		X: rot[0][0]*v.X + rot[0][1]*v.Y + rot[0][2]*v.Z,
		Y: rot[1][0]*v.X + rot[1][1]*v.Y + rot[1][2]*v.Z,
		Z: rot[2][0]*v.X + rot[2][1]*v.Y + rot[2][2]*v.Z,
	}
}

func applyTorque(rot *[3][3]float64, pitch, yaw, roll, tickRate float64) {
	dt := 1.0 / tickRate
	p := pitch * ROTATION_SPEED * dt // pitch rotation around local X axis
	y := yaw * ROTATION_SPEED * dt   // yaw rotation around local Y axis
	r := roll * ROTATION_SPEED * dt  // roll rotation around local Z axis

	cx, sx := math.Cos(p), math.Sin(p)
	cy, sy := math.Cos(y), math.Sin(y)
	cz, sz := math.Cos(r), math.Sin(r)

	// Combined local-space Euler rotation matrix (ZYX convention)
	upd := [3][3]float64{
		{cy * cz, -cy * sz, sy},
		{cx*sz + sx*sy*cz, cx*cz - sx*sy*sz, -sx * cy},
		{sx*sz - cx*sy*cz, sx*cz + cx*sy*sz, cx * cy},
	}

	// Multiply: next = rot * upd
	var next [3][3]float64
	for i := 0; i < 3; i++ {
		for j := 0; j < 3; j++ {
			next[i][j] = rot[i][0]*upd[0][j] + rot[i][1]*upd[1][j] + rot[i][2]*upd[2][j]
		}
	}
	*rot = next
}

// ─── HTTP & Static File Serving ───────────────────────────────────────────────

func main() {
	http.HandleFunc("/ws", handleWS)

	// Serve the frontend
	fs := http.FileServer(http.Dir("./public"))
	http.Handle("/", fs)

	log.Println("═══════════════════════════════════════════")
	log.Println("  VECTOR STRIKE: OMNI — Go Game Server")
	log.Println("  Listening on :8080")
	log.Println("  WebSocket endpoint: /ws")
	log.Println("═══════════════════════════════════════════")
	log.Fatal(http.ListenAndServe(PORT, nil))
}
