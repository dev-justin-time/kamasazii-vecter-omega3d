const fs = require('fs');
const path = require('path');

const htmlPath = path.join(__dirname, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');

const oldLog = "console.log('[SHIP] Loaded ' + name + ': ' + model.vertexCount + ' verts, ' + model.indexCount + ' indices');";
const newLog = "console.log('[SHIP] Loaded ' + name + ': ' + model.vertexCount + ' verts, ' + model.indexCount + ' indices, diag=' + diagonal.toFixed(1) + ', scale=' + unitScale.toFixed(3) + ', bbox=(' + minX.toFixed(1) + ',' + minY.toFixed(1) + ',' + minZ.toFixed(1) + ')~(' + maxX.toFixed(1) + ',' + maxY.toFixed(1) + ',' + maxZ.toFixed(1) + ')');";

if (html.includes(oldLog)) {
    html = html.replace(oldLog, newLog);
    fs.writeFileSync(htmlPath, html);
    console.log('OK: Console log enhanced');
} else {
    console.log('NO_CHANGE: Pattern not found');
}
