// Measurement-only: print minified definitions from the cached fleet build, to name profile frames.
const fs = require('fs'), os = require('os'), path = require('path')
const root = path.join(os.homedir(), '.cache/orca-fleet-gate/builds')
const dir = fs.readdirSync(root).find((d) => d.startsWith(process.argv[2]) && !d.endsWith('.log'))
const base = path.join(root, dir, 'out/main')
const files = fs.readdirSync(path.join(base, 'chunks')).map((f) => 'chunks/' + f).concat(['index.js'])
const wanted = JSON.parse(fs.readFileSync(path.join(__dirname, process.argv[3]), "utf8"))
for (const [prefix, line, names] of wanted) {
  const file = files.find((f) => f === prefix || f.startsWith('chunks/' + prefix) || f.startsWith(prefix))
  if (!file) { console.log('WHOIS missing', prefix); continue }
  const text = fs.readFileSync(path.join(base, file), 'utf8').split('\n')[line - 1] ?? ''
  for (const name of names) {
    const re = new RegExp(`(?:function\\s+${name}\\s*\\(|[,;{\\s]${name}\\s*=\\s*(?:async\\s*)?(?:function|\\()|[,;{}\\s]${name}\\s*\\([^)]*\\)\\s*\\{)`, 'g')
    let m, n = 0
    while ((m = re.exec(text)) && n < 3) { n++; console.log(`WHOIS ${file}:${line} ${name} @${m.index}: ${text.slice(Math.max(0, m.index - 120), m.index + 700).replace(/\s+/g, ' ')}`) }
    if (n === 0) console.log(`WHOIS ${file}:${line} ${name} not found`)
  }
}
const mapFile = path.join(base, 'index.js.map')
console.log('WHOIS maps', fs.existsSync(mapFile))
