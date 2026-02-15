import re
import json

class NaninovelParser:

    def __init__(self):
        # 角色中文名映射
        self.char_map = {
            "Ema": "樱羽艾玛",
            "Hiro": "二阶堂希罗",
            "Meruru": "冰上梅露露",
            "Milia": "佐伯米莉亚",
            "Hanna": "远野汉娜",
            "Margo":"宝生玛格",
            "Sherry":"橘雪莉",
            "Leia":"莲见蕾雅",
            "AnAn":"夏目安安",
            "Noah":"城崎诺亚",
            "Nanoka":"黑部奈叶香",
            "Miria":"佐伯米莉亚",
            "Alisa":"亚里沙",
            "Yuki":"月代雪",
            "Warden": "典狱长", 
            "Jailer": "看守",
            "Narrative": "旁白",
            "Unknown": "未知角色"
        }

        self.unknown_map = {
            "遠野ハンナ": "Hanna",
            "佐伯ミリア": "Milia",
            "紫藤アリサ": "Alisa",
            "二階堂ヒロ": "Hiro",
            "城崎ノア": "Noah",
            "黒部ナノカ": "Nanoka",
            "宝生マグ": "Margo",
            "橘シェリー": "Sherry",
            "月代ユキ": "Yuki",
            "夏目アンアン": "AnAn",
            "氷上メルル": "Meruru",
            "蓮見レイア": "Leia",
            "佐伯ミリア": "Milia",
            "桜羽エマ": "Ema",
            "備考◆配信中":"Warden"
        }

    def clean_text(self, text: str) -> str:
        """清理文本，去除多余的空白和控制字符"""
        # 替换 HTML 换行符为实际换行
        text = text.replace("<br>", "\n")
        # 去除多余的<ruby>标签，只保留正文
        text = re.sub(r"<ruby>(.*?)</ruby>", r"\1", text)
        return text.strip()
    
    def parse_file(self, content: str, file_name: str) -> list[dict]:
        """解析 Naninovel 脚本文件内容，提取对话和场景信息"""
        lines = content.splitlines()
        extracted_data = []

        # 初始化当前块
        current_block = {
            "id": None,
            "speaker": "Unknown",
            "original_speaker_code": None,
            "text": ""
        }

        for line in lines:
            line = line.strip()

            # 1. 识别 ID 行, 标记为新一句的开始
            if line.startswith("#"):
                # 如果当前块有内容，先保存
                if current_block["text"] and current_block["id"] is not None:
                    extracted_data.append(dict(current_block))

                # 开始新的块
                current_block = {
                    "id": line[1:].strip(),
                    "speaker": "旁白",
                    "original_speaker_code": "Narrative",
                    "text": "",
                    "file_name": file_name
                }

                # 根据 ID 预测角色
                if "Narrative" in line:
                    current_block["speaker"] = "旁白"
                    current_block["original_speaker_code"] = "Narrative"
                # 其他情况
                elif "_" in current_block["id"]:
                    # 尝试从角色代码中获取角色名称
                    parts = current_block["id"].split("_")
                    if len(parts) > 1:
                        potential_code = re.match(r"([a-zA-Z]+)", parts[-1])
                        if potential_code:
                            code = potential_code.group(1)
                            current_block["original_speaker_code"] = code
                            current_block["speaker"] = self.char_map.get(code, code)

            # 2. 识别对话行
            elif line.startswith(";"):
                # [优先级 High] 处理 @ 具体角色名 (如 ; > ＠二階堂ヒロ)
                if ">" in line and "＠" in line:
                    match = re.search(r'＠(.*?)$', line)
                    if match:
                        raw_name = match.group(1).strip()
                        
                        # 映射逻辑：原文 -> 英文Key -> 中文
                        english_key = self.unknown_map.get(raw_name, raw_name) # 得到 Hiro
                        chinese_name = self.char_map.get(english_key, english_key) # 得到 二阶堂希罗
                        
                        current_block["speaker"] = chinese_name
                        current_block["original_speaker_code"] = english_key
                        continue # 处理完这行直接跳过，防止逻辑冲突

                # [优先级 Medium] 处理通用定义 (如 ; > Unknown: ...)
                if ">" in line and ":" in line:
                    match = re.search(r'>\s*([a-zA-Z0-9_]+):', line)
                    if match:
                        code = match.group(1)
                        
                        # 【核心修复逻辑】
                        # 如果读到的 code 是 "Unknown"，但我们现在的 speaker 已经是具体的中文名了（比如 "二阶堂希罗"）
                        # 并且这个名字不在 ["未知角色", "Unknown", "旁白"] 这些默认值里
                        # 那么就说明我们之前通过 @ 拿到过名字了，千万不要覆盖！
                        if code == "Unknown" and current_block["speaker"] not in ["未知角色", "Unknown", "旁白"]:
                            pass # 忽略这次覆盖
                        else:
                            # 正常覆盖
                            current_block["original_speaker_code"] = code
                            current_block["speaker"] = self.char_map.get(code, code)
                        
            # 3. 识别文本行
            elif line:
                cleaned_text = self.clean_text(line)
                if current_block["text"]:
                    current_block["text"] += "\n" + cleaned_text
                else:
                    current_block["text"] = cleaned_text
        
        # 保存最后一个块
        if current_block["text"] and current_block["id"] is not None:
            extracted_data.append(dict(current_block))

        return extracted_data
    

if __name__ == "__main__":
    parser = NaninovelParser()
    with open("Act01_Chapter01_Adv02.bytes", "r", encoding="utf-8") as f:
        sample_content = f.read()
    data = parser.parse_file(sample_content, "Act01_Chapter01_Adv02")
    with open("Act01_Chapter01_Adv02.json", "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2) 
    # 结构化输出 JSON  
    print(json.dumps(data, ensure_ascii=False, indent=2))