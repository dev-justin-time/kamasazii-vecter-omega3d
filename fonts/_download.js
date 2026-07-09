/**
 * _download.js — Self-hosting helper for the three Google Fonts
 * (JetBrains Mono / Noto Sans JP / Stick No Bills).
 *
 * Reads the sibling CSS dumps already fetched from Google Fonts with a Chrome
 * UA, downloads each unique woff2 file into ./ alongside a `fonts.css` that
 * mirrors the source's @font-face + unicode-range layout (so the browser
 * picks the right file per character).
 *
 * Run once from inside this directory:   node _download.js
 * Delete the _*.css dumps + this script after the run.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');

const FONTS_DIR = __dirname;
const FAMILY_SLUG = {
  'JetBrains Mono': 'JetBrainsMono',
  'Noto Sans JP':   'NotoSansJP',
  'Stick No Bills': 'StickNoBills',
};
const WEIGHT_NAME = {
  100: 'Thin', 200: 'ExtraLight', 300: 'Light',
  400: 'Regular', 500: 'Medium', 600: 'SemiBold',
  700: 'Bold', 800: 'ExtraBold', 900: 'Black',
};

function slugify(s) { return String(s).replace(/[^a-z0-9-]/gi, ''); }

/** Last path segment of a URL, sans extension, slugified — used to build the
 *  local woff2 filename even for subsets Google doesn't give a friendly
 *  comment label to (Noto Sans JP Japanese subsets end in numeric ids). */
function labelFromUrl(url) {
  const m = String(url).match(/\/([^/]+)\.woff2\)?$/);
  if (!m) return 'subset';
  // Take the trailing meaningful portion so the name is short and human-skimmable.
  // e.g. ".../cb4.61.woff2" → "cb4-61"; ".../tDbV2o…OwE.woff2" → "OwE".
  const tail = m[1].split(/[._-]+/).filter(Boolean).slice(-3).join('-');
  return slugify(tail) || 'subset';
}

/** Download a URL to disk, following one redirect if needed. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.destroy();
        try { fs.unlinkSync(dest); } catch (_) {}
        return resolve(download(res.headers.location, dest));
      }
      if (res.statusCode !== 200) {
        file.destroy();
        try { fs.unlinkSync(dest); } catch (_) {}
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('error', (err) => {
      try { fs.unlinkSync(dest); } catch (_) {}
      reject(err);
    });
  });
}

/**
 * Parse one Google Fonts CSS dump into structured @font-face blocks.
 * Walks the file from "@font-face {" to the next closing brace — works for
 * both JBM (which prefixes every block with `/* subset *\/`) and NSJP (which
 * emits naked @font-face blocks stacked end to end).
 */
function parseCSSFile(filepath) {
  const text = fs.readFileSync(filepath, 'utf8');
  const blockRegex = /@font-face\s*{([\s\S]+?)\n}\s*/g;
  const blocks = [];
  let m;
  while ((m = blockRegex.exec(text)) !== null) {
    const body = m[1];
    const family = (body.match(/font-family:\s*'([^']*)'/) || [])[1];
    const style = (body.match(/font-style:\s*(\w+)/) || [])[1] || 'normal';
    const weight = (body.match(/font-weight:\s*(\d+)/) || [])[1] || '400';
    const url = (body.match(/src:\s*url\((https:\/\/[^)]+)\)\s*format\('woff2'\)/) || [])[1];
    const range = (body.match(/unicode-range:\s*([^;]+);/) || [])[1];
    if (!family || !url) continue;
    // Optional /* subset */ label immediately above the @font-face — capture for
    // a more human-friendly filename than the URL tail when present.
    const beforeStart = text.lastIndexOf('@font-face', m.index);
    const commentChunk = text.slice(Math.max(0, beforeStart - 200), beforeStart);
    const commentMatch = commentChunk.match(/\/\*\s*([a-z0-9\- ]+?)\s*\*\/\s*$/i);
    const comment = commentMatch ? commentMatch[1].trim() : null;
    blocks.push({ comment, family, style, weight, url, range });
  }
  return blocks;
}

async function main() {
  const cssFiles = [
    { src: '_jbm.css', label: 'JetBrains Mono' },
    { src: '_nsjp.css', label: 'Noto Sans JP' },
    { src: '_snb.css', label: 'Stick No Bills' },
  ];

  const banner = [
    '/* ════════════════════════════════════════════════════════════════════════════',
    '   Self-hosted Fonts',
    '   Originally served via https://fonts.googleapis.com/css2?… which was blocked',
    '   by the kamikazii CSP (style-src \'self\' only). Every woff2 below was',
    '   downloaded from fonts.gstatic.com (one-time migration) and now lives next',
    '   to this file. unicode-range blocks are preserved verbatim so the browser',
    '   picks the right file per character — do not collapse them.',
    '   ════════════════════════════════════════════════════════════════════════════ */',
    '',
  ];
  // url → local filename (URL-level dedupe — Google uses the same woff2 across
  // weights when serving a variable font, so this is correct).
  const seenUrls = new Map();
  const outLines = [...banner];
  let downloaded = 0;
  let aliasHits = 0;
  let totalSize = 0;

  for (const { src, label } of cssFiles) {
    const filepath = path.join(FONTS_DIR, src);
    if (!fs.existsSync(filepath)) {
      console.warn(`skip: ${src} not found`);
      continue;
    }

    const familySlug = FAMILY_SLUG[label];
    if (!familySlug) {
      console.warn(`skip: no FAMILY_SLUG entry for '${label}'`);
      continue;
    }

    const blocks = parseCSSFile(filepath);
    if (!blocks.length) {
      console.warn(`skip: ${src} parsed to zero @font-face blocks`);
      continue;
    }

    outLines.push(`/* ─── ${label} ─────────────────────────────────────────────────────── */`, '');

    for (const block of blocks) {
      let localName = seenUrls.get(block.url);
      if (!localName) {
        const wTag = WEIGHT_NAME[block.weight] || `w${block.weight}`;
        // Prefer the JBM-style subset comment when present, else fall back to
        // the URL-derived label (NSJP's Japanese subsets have numeric ids).
        const subsetTag = (block.comment && /^[a-z0-9-]+$/i.test(block.comment))
          ? block.comment
          : labelFromUrl(block.url);
        // Strip redundant family/weight prefix that already exists so the
        // filename doesn't double up — but keep it if URL-only.
        const cleanTag = subsetTag.startsWith(wTag) ? subsetTag : subsetTag;
        localName = `${familySlug}-${wTag}-${cleanTag}.woff2`;
        seenUrls.set(block.url, localName);
        try {
          await download(block.url, path.join(FONTS_DIR, localName));
          const size = fs.statSync(path.join(FONTS_DIR, localName)).size;
          totalSize += size;
          downloaded++;
          // Per-file log — only first ~40 to keep noise low; full count below.
          if (downloaded <= 5 || downloaded === Math.floor(seenUrls.size / 25) * 25) {
            console.log(`  ✓ ${localName}  (${(size / 1024).toFixed(1)} KB)`);
          }
        } catch (err) {
          console.error(`  ✗ FAILED ${block.url}: ${err.message}`);
          continue;
        }
      } else {
        aliasHits++;
      }

      outLines.push(
        block.comment ? `/* ${block.comment} */` : `/* ${labelFromUrl(block.url)} */`,
        `@font-face {`,
        `  font-family: '${block.family}';`,
        `  font-style: ${block.style};`,
        `  font-weight: ${block.weight};`,
        `  font-display: swap;`,
        `  src: url('./${localName}') format('woff2');`,
        block.range ? `  unicode-range: ${block.range};` : null,
        `}`,
        '',
      );
    }
    outLines.push('');
  }

  fs.writeFileSync(path.join(FONTS_DIR, 'fonts.css'), outLines.filter(Boolean).join('\n'));
  console.log(
    `\n→ unique woff2 files: ${downloaded} downloaded, ${aliasHits} aliased (URL shared across weights)`
      + `\n→ total size on disk: ${(totalSize / 1024 / 1024).toFixed(2)} MB`
      + `\n→ wrote fonts.css with ${seenUrls.size} URL → woff2 mappings preserved`,
  );
}

main().catch((err) => { console.error(err); process.exit(1); });
