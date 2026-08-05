const fs = require('fs')
const raw = fs.readFileSync('src/assets/china-geo.json', 'utf8')
const esc = raw.replace(/\/g, '\\').replace(/`/g, '\`').replace(/\$\{/g, '\${')
const out = `import type { ExtendedFeatureCollection } from 'd3-geo'

/** 中国省级边界 GeoJSON（DataV GeoAtlas 下载，d3-geo 投影渲染用） */
export default JSON.parse(\`${esc}\`) as unknown as ExtendedFeatureCollection
`
fs.writeFileSync('src/assets/china-geo.ts', out)
console.log('china-geo.ts bytes:', out.length)
