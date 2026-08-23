/**
 * NBS 地区代码表（data capability）：国标行政区划代码（GB/T 2260 公共事实数据）→
 * 新版国家数据 API 的 das.value 12 位区划码。省区市全量 + 职业决策常用城市。
 * 名称匹配：全名/短名/包含（对齐参考实现 mcp-cnbs 的 getRegionByName 语义，MIT 复用思路）。
 */
export interface NbsRegion {
  code: string // 12 位区划代码（城市后 6 位为 0）
  name: string // 全名
  shortName: string // 短名（用户口语）
  level: 'nation' | 'province' | 'city'
}

export const NBS_REGIONS: NbsRegion[] = [
  { code: '000000000000', name: '全国', shortName: '全国', level: 'nation' },
  // 省、自治区、直辖市
  { code: '110000000000', name: '北京市', shortName: '北京', level: 'province' },
  { code: '120000000000', name: '天津市', shortName: '天津', level: 'province' },
  { code: '130000000000', name: '河北省', shortName: '河北', level: 'province' },
  { code: '140000000000', name: '山西省', shortName: '山西', level: 'province' },
  { code: '150000000000', name: '内蒙古自治区', shortName: '内蒙古', level: 'province' },
  { code: '210000000000', name: '辽宁省', shortName: '辽宁', level: 'province' },
  { code: '220000000000', name: '吉林省', shortName: '吉林', level: 'province' },
  { code: '230000000000', name: '黑龙江省', shortName: '黑龙江', level: 'province' },
  { code: '310000000000', name: '上海市', shortName: '上海', level: 'province' },
  { code: '320000000000', name: '江苏省', shortName: '江苏', level: 'province' },
  { code: '330000000000', name: '浙江省', shortName: '浙江', level: 'province' },
  { code: '340000000000', name: '安徽省', shortName: '安徽', level: 'province' },
  { code: '350000000000', name: '福建省', shortName: '福建', level: 'province' },
  { code: '360000000000', name: '江西省', shortName: '江西', level: 'province' },
  { code: '370000000000', name: '山东省', shortName: '山东', level: 'province' },
  { code: '410000000000', name: '河南省', shortName: '河南', level: 'province' },
  { code: '420000000000', name: '湖北省', shortName: '湖北', level: 'province' },
  { code: '430000000000', name: '湖南省', shortName: '湖南', level: 'province' },
  { code: '440000000000', name: '广东省', shortName: '广东', level: 'province' },
  { code: '450000000000', name: '广西壮族自治区', shortName: '广西', level: 'province' },
  { code: '460000000000', name: '海南省', shortName: '海南', level: 'province' },
  { code: '500000000000', name: '重庆市', shortName: '重庆', level: 'province' },
  { code: '510000000000', name: '四川省', shortName: '四川', level: 'province' },
  { code: '520000000000', name: '贵州省', shortName: '贵州', level: 'province' },
  { code: '530000000000', name: '云南省', shortName: '云南', level: 'province' },
  { code: '540000000000', name: '西藏自治区', shortName: '西藏', level: 'province' },
  { code: '610000000000', name: '陕西省', shortName: '陕西', level: 'province' },
  { code: '620000000000', name: '甘肃省', shortName: '甘肃', level: 'province' },
  { code: '630000000000', name: '青海省', shortName: '青海', level: 'province' },
  { code: '640000000000', name: '宁夏回族自治区', shortName: '宁夏', level: 'province' },
  { code: '650000000000', name: '新疆维吾尔自治区', shortName: '新疆', level: 'province' },
  // 职业决策常用城市（计划单列市/省会/强地级市——按需扩，不追求全量）
  { code: '320100000000', name: '南京市', shortName: '南京', level: 'city' },
  { code: '320500000000', name: '苏州市', shortName: '苏州', level: 'city' },
  { code: '320200000000', name: '无锡市', shortName: '无锡', level: 'city' },
  { code: '320400000000', name: '常州市', shortName: '常州', level: 'city' },
  { code: '330100000000', name: '杭州市', shortName: '杭州', level: 'city' },
  { code: '330200000000', name: '宁波市', shortName: '宁波', level: 'city' },
  { code: '330300000000', name: '温州市', shortName: '温州', level: 'city' },
  { code: '350200000000', name: '厦门市', shortName: '厦门', level: 'city' },
  { code: '370200000000', name: '青岛市', shortName: '青岛', level: 'city' },
  { code: '370100000000', name: '济南市', shortName: '济南', level: 'city' },
  { code: '440100000000', name: '广州市', shortName: '广州', level: 'city' },
  { code: '440300000000', name: '深圳市', shortName: '深圳', level: 'city' },
  { code: '440600000000', name: '佛山市', shortName: '佛山', level: 'city' },
  { code: '441900000000', name: '东莞市', shortName: '东莞', level: 'city' },
  { code: '430100000000', name: '长沙市', shortName: '长沙', level: 'city' },
  { code: '420100000000', name: '武汉市', shortName: '武汉', level: 'city' },
  { code: '410100000000', name: '郑州市', shortName: '郑州', level: 'city' },
  { code: '510100000000', name: '成都市', shortName: '成都', level: 'city' },
  { code: '610100000000', name: '西安市', shortName: '西安', level: 'city' },
  { code: '210200000000', name: '大连市', shortName: '大连', level: 'city' },
  { code: '230100000000', name: '哈尔滨市', shortName: '哈尔滨', level: 'city' },
  { code: '220100000000', name: '长春市', shortName: '长春', level: 'city' },
  { code: '210100000000', name: '沈阳市', shortName: '沈阳', level: 'city' },
  { code: '350100000000', name: '福州市', shortName: '福州', level: 'city' },
  { code: '340100000000', name: '合肥市', shortName: '合肥', level: 'city' },
  { code: '360100000000', name: '南昌市', shortName: '南昌', level: 'city' },
  { code: '450100000000', name: '南宁市', shortName: '南宁', level: 'city' },
  { code: '520100000000', name: '贵阳市', shortName: '贵阳', level: 'city' },
  { code: '530100000000', name: '昆明市', shortName: '昆明', level: 'city' },
  { code: '620100000000', name: '兰州市', shortName: '兰州', level: 'city' },
]

/** 地区名 → 区划代码（全名/短名精确优先，包含兜底；未命中 = undefined） */
export function findRegionCode(input: string): string | undefined {
  const q = input.trim()
  if (q.length === 0) return undefined
  const exact = NBS_REGIONS.find((r) => r.name === q || r.shortName === q)
  if (exact !== undefined) return exact.code
  const fuzzy = NBS_REGIONS.find((r) => r.name.includes(q) || q.includes(r.shortName))
  return fuzzy?.code
}
