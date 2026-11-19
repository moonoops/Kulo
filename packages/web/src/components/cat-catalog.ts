export const CAT_APPEARANCES = [
  { id: "sunglasses", labelZh: "墨镜", labelEn: "Sunglasses", sheet: 0, row: 0 },
  { id: "programmer", labelZh: "程序员", labelEn: "Programmer", sheet: 0, row: 1 },
  { id: "closeup", labelZh: "怼脸", labelEn: "Close-up", sheet: 0, row: 2 },
  { id: "headphones", labelZh: "耳机", labelEn: "Headphones", sheet: 0, row: 3 },
  { id: "hat-scarf", labelZh: "帽子围巾", labelEn: "Hat and scarf", sheet: 1, row: 0 },
  { id: "beret", labelZh: "贝雷帽", labelEn: "Beret", sheet: 1, row: 1 },
  { id: "cap", labelZh: "鸭舌帽", labelEn: "Cap", sheet: 1, row: 2 },
  { id: "beanie", labelZh: "针织帽", labelEn: "Beanie", sheet: 1, row: 3 },
  { id: "bucket-hat", labelZh: "渔夫帽", labelEn: "Bucket hat", sheet: 2, row: 0 },
  { id: "raincoat", labelZh: "雨衣帽", labelEn: "Raincoat", sheet: 2, row: 1 },
  { id: "hoodie", labelZh: "连帽衫", labelEn: "Hoodie", sheet: 2, row: 2 },
  { id: "nightcap", labelZh: "睡帽", labelEn: "Nightcap", sheet: 2, row: 3 },
  { id: "thinking", labelZh: "思考", labelEn: "Thinking", sheet: 3, row: 0 },
  { id: "reading", labelZh: "阅读", labelEn: "Reading", sheet: 3, row: 1 },
  { id: "writing", labelZh: "记录", labelEn: "Writing", sheet: 3, row: 2 },
  { id: "idea", labelZh: "灵感", labelEn: "Idea", sheet: 3, row: 3 },
  { id: "wave", labelZh: "招手", labelEn: "Wave", sheet: 4, row: 0 },
  { id: "celebrate", labelZh: "完成", labelEn: "Completed", sheet: 4, row: 1 },
  { id: "waiting", labelZh: "等待", labelEn: "Waiting", sheet: 4, row: 2 },
  { id: "dozing", labelZh: "打盹", labelEn: "Dozing", sheet: 4, row: 3 },
  { id: "sleep-curled", labelZh: "蜷团睡", labelEn: "Curled sleep", sheet: 5, row: 0 },
  { id: "sleep-side", labelZh: "枕头侧睡", labelEn: "Pillow sleep", sheet: 5, row: 1 },
  { id: "sleep-belly-up", labelZh: "仰睡", labelEn: "Belly-up sleep", sheet: 5, row: 2 },
  { id: "sleep-slumped", labelZh: "靠墙睡", labelEn: "Slumped sleep", sheet: 5, row: 3 },
] as const;

export type CatAppearanceId = typeof CAT_APPEARANCES[number]["id"];
export type CatAppearance = "auto" | CatAppearanceId;
export const CAT_SHEET_GRID = 4;
export const CAT_SHEET_URLS = Array.from({ length: 6 }, (_, index) => `/mascots/cat/actions-${index}.webp`);

export const CAT_NATIVE_FRAME_SIZE = 314;
export type CatCrop = readonly [x: number, y: number, size: number];
const fullFrame: CatCrop = [0, 0, CAT_NATIVE_FRAME_SIZE];

// Each portrait uses one square crop measured across all four poses. Its bottom
// sits inside the shortest torso, while the top retains every pose's hat/ears.
const portraitCrops: Partial<Record<CatAppearanceId, CatCrop>> = {
  sunglasses: [10, 0, 297], programmer: [5, 1, 309], closeup: [7, -1, 298], headphones: [10, -1, 298],
  "hat-scarf": [18, 20, 276], beret: [15, 14, 281], cap: [19, 19, 276], beanie: [17, 18, 277],
  "bucket-hat": [20, -2, 293], raincoat: [22, 8, 285], hoodie: [26, 13, 279], nightcap: [25, -7, 286],
  thinking: [14, 15, 289], reading: [12, 10, 294], writing: [14, 16, 289], idea: [14, 11, 292],
  wave: [20, 21, 276], celebrate: [19, 15, 282], waiting: [18, 13, 284], dozing: [14, 2, 289],
};

export function getCatAppearanceCrop(id: CatAppearanceId): CatCrop {
  return portraitCrops[id] ?? fullFrame;
}

export function isCatAppearance(value: unknown): value is CatAppearance {
  return value === "auto" || CAT_APPEARANCES.some((appearance) => appearance.id === value);
}

export function getCatAppearance(id: CatAppearanceId) {
  return CAT_APPEARANCES.find((appearance) => appearance.id === id)!;
}
