// [官方角色名单](https://manosaba.com/posts/illustcontest)
export const witchTrialCharacterNames = [
  ['樱羽艾玛', '桜羽エマ', 'Sakuraba Ema', 'Sakuraba Emma', 'Ema Sakuraba', 'Emma Sakuraba'],
  ['二阶堂希罗', '二階堂ヒロ', 'Nikaido Hiro', 'Hiro Nikaido'],
  ['夏目安安', '夏目アンアン', 'Natsume An-An', 'An-An Natsume'],
  ['城崎诺亚', '城ケ崎ノア', '城ヶ崎ノア', 'Jougasaki Noa', 'Noa Jougasaki', 'Kinosaki Noah'],
  ['莲见蕾雅', '蓮見レイア', 'Hasumi Leia', 'Leia Hasumi'],
  ['佐伯米莉亚', '佐伯ミリア', 'Saeki Milia', 'Milia Saeki'],
  ['宝生玛格', '宝生マーゴ', 'Hosho Margo', 'Margo Hosho'],
  ['紫藤亚里沙', '紫藤アリサ', 'Shido Arisa', 'Arisa Shido', 'Shito Arisa'],
  ['橘雪莉', '橘シェリー', 'Tachibana Sherry', 'Sherry Tachibana'],
  ['远野汉娜', '遠野ハンナ', 'Tono Hannah', 'Hannah Tono'],
  ['泽渡可可', '泽度可可', '沢渡ココ', 'Sawatari Coco', 'Coco Sawatari'],
  ['黑部奈叶香', '黒部ナノカ', 'Kurobe Nanoka', 'Nanoka Kurobe'],
  ['黑部穗乃香', '黒部ホノカ', 'Kurobe Honoka', 'Honoka Kurobe'],
  ['冰上梅露露', '氷上メルル', 'Hikami Meruru', 'Meruru Hikami', 'Hikawa Meruru'],
  ['月代雪', '月代ユキ', 'Tsukishiro Yuki', 'Yuki Tsukishiro'],
] as const;

const fullNames = new Set<string>(
  witchTrialCharacterNames.flatMap(names => names.map(name => name.toLowerCase())),
);

/** 只匹配完整姓名, 不把昵称, 角色描述或包含姓名的任意文本当作剧情角色. */
export function isWitchTrialCharacter(name: string): boolean {
  return fullNames.has(name.trim().toLowerCase());
}
