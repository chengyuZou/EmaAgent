import os
import re
import json
import glob
from pathlib import Path
from tqdm import tqdm

ROOT_DIR = r"e:\魔裁数据\Localization\zh-Hans\Text\Scripts"
OUTPUT_FILE = "game_memory_dump.json"

class Processor:
    def __init__(self):
        # 角色中文名映射
        self.char_map = {
            "Ema": "樱羽艾玛",
            "Hiro": "二阶堂希罗",
            "Meruru": "冰上梅露露",
            "Milia": "佐伯米莉亚",
            "Hanna": "远野汉娜",
            "Coco": "泽度可可",
            "Margo":"宝生玛格",
            "Sherry":"橘雪莉",
            "Leia":"莲见蕾雅",
            "AnAn":"夏目安安",
            "Noah":"城崎诺亚",
            "Nanoka":"黑部奈叶香",
            "Miria":"佐伯米莉亚",
            "Alisa":"紫藤亚里沙",
            "Yuki":"月代雪",
            "Warden": "典狱长", 
            "Jailer": "看守",
            "Narrative": "旁白",
            "Unknown": "未知角色",
            "Choice": "选择",
            "System": "系统提示"
        }

        self.unknown_map = {
            "遠野ハンナ": "远野汉娜",
            "佐伯ミリア": "佐伯米莉亚",
            "紫藤アリサ": "紫藤亚里沙",
            "二階堂ヒロ": "二阶堂希罗",
            "城崎ノア": "城崎诺亚",
            "黒部ナノカ": "黑部奈叶香",
            "宝生マグ": "宝生玛格",
            "橘シェリー": "橘雪莉",
            "月代ユキ": "月代雪",
            "夏目アンアン": "夏目安安",
            "氷上メルル": "冰上梅露露",
            "蓮見レイア": "莲见蕾雅",
            "佐伯ミリア": "佐伯米莉亚",
            "桜羽エマ": "樱羽艾玛",  
            "備考◆配信中":"典狱长"
        }

        self.data = []
        self.Adv05_last = []  # 用于存储 Act02_Chapter05 的后4个 Adv 文件

    def clean_text(self, text: str) -> str:
        """清理文本，去除多余的空白和控制字符"""
        if not text: return ""
        # 清除<br>标签
        text = text.replace("<br>", "\n")
        text = re.sub(r'<ruby=".*?">(.*?)</ruby>', r'\1', text)
        text = re.sub(r'<link=".*?">(.*?)</link>', r'\1', text)
        text = re.sub(r'<[^>]+>', '', text)
        return text.strip()
    
    def determine_timeline(self, folder_name: str) -> str:
        """根据文件夹名称确定时间线"""
        #print(f"Determining timeline for folder: {folder_name}")
        match = re.match(r"Act(\d+)_Chapter(\d+)", folder_name)
        if not match:
            return "Unknown_Loop"
        
        act = int(match.group(1))
        chapter = int(match.group(2))

        # 根据时间线规则进行判断
        if act > 2:
            return "3rd_Loop"
        elif act == 2 and chapter >= 5:
            return "3rd_Loop"
        elif act == 2:
            return "2nd_Loop"
        else:
            return "1st_Loop"
        
    def extract_speaker_from_id(self, line_id):
        """从 ID 中推断说话人 (Trial 专用)"""
        # 特殊处理 Common_Return 等通用ID
        if "Common_" in line_id or "Choice" in line_id:
            return "系统选项"
        
        # 正常分离角色代码
        parts = line_id.split("_")
        if len(parts) >= 2:
            # 尝试从最后一个部分中提取角色代码
            raw_code = re.match(r'([a-zA-Z]+)', parts[-1])
            if raw_code:
                # 尝试从角色代码中获取中文名称
                code = raw_code.group(1)
                chinese_name = self.char_map.get(code, "未知角色")
                return chinese_name
        return "未知角色"

    def parse_file(self, file_path: str):
        print(f"Processing file: {file_path}")
        # 文件名称
        file_name = os.path.basename(file_path)
        # 文件夹
        folder = os.path.basename(os.path.dirname(file_path))
        timeline = self.determine_timeline(folder)

        # 场景判断
        scene_type = "Trial" if "Trial" in file_name else "Adventure"

        # 打开文件
        with open(file_path, "r", encoding="utf-8") as f:
            lines = f.read().splitlines()

        # 块初始化
        current_block = {
            "timeline": timeline,
            "chapter": folder,
            "file": file_name,
            "id": "",
            "type": scene_type,
            "speaker": "旁白",
            "text": ""
        }
        
        # 开始处理文件
        for line in lines:

            # 识别 ID 行
            if line.startswith("#"):
                # 保存上一块
                if current_block and current_block["text"]:
                    self.data.append(dict(current_block))
                
                # 分开空格
                line_id = line[1:].strip()
                # 初始化新块
                current_block = {
                    "timeline": timeline,
                    "chapter": folder,
                    "file": file_name,
                    "id": line_id,
                    "type": scene_type,
                    "speaker": "旁白",
                    "text": ""
                }

                # 如果为 Trial 场景，识别对话行
                if scene_type == "Trial":
                    current_block["speaker"] = self.extract_speaker_from_id(line_id)
            
            # 元数据行(; > ...)
            elif line.startswith(";"):
                # if not current_block: continue
                # 检测是否为 Choice 行
                if "＠Choice" in line:
                    current_block["type"] = "Choice"
                    current_block["speaker"] = "系统选项"
                    continue

                # 提取 Speaker 名称(先前已从Trial断过)
                if ">" in line and "＠" in line:
                    # ; > ＠二階堂ヒロ
                    match = re.search(r'＠(.*?)$', line)
                    if match:
                        raw_name = match.group(1).strip()
                        
                        # 映射逻辑：日文名称 -> 中文
                        chinese_name = self.unknown_map.get(raw_name, "未知角色")
                        print(f"Mapped name: {raw_name} -> {chinese_name}")
                        current_block["speaker"] = chinese_name
                        continue

                elif ">" in line and "＠" not in line and ":" in line:
                    # ; > Ema: |#0101Adv02_Ema010|
                    # 只有当当前说话人不是通过＠识别出来的，才更新说话人
                    match = re.search(r'>\s*([a-zA-Z0-9_]+):', line)
                    if match:
                        code = match.group(1).strip()
                        name = self.char_map.get(code, code)
                        # 如果当前说话人是"旁白"或"未知角色"，则更新说话人
                        # 这样可以避免Unknown覆盖已经通过＠识别出的说话人
                        if current_block["speaker"] == "旁白":
                            current_block["speaker"] = name

            # 文本行
            elif line:
                if line.startswith("＠"): continue

                # 清理文本
                current_text = self.clean_text(line)
                if current_block["text"]:
                    current_block["text"] += "\n" + current_text
                else:
                    current_block["text"] = current_text
        
        # 保存最后一块
        if current_block and current_block["text"]:
            self.data.append(dict(current_block))

    def run(self, root_dir: str, output_file: str):
        all_files = list(Path(root_dir).rglob("Act*.bytes"))
        # 过滤 Bad Files
        files = list(filter(lambda f: "Bad" not in str(f), all_files))
        
        # 按文件夹分组处理
        files_by_folder = {}
        for file_path in files:
            folder = os.path.basename(file_path.parent)  # 获取文件所在的文件夹名
            if folder not in files_by_folder:
                files_by_folder[folder] = []
            files_by_folder[folder].append(file_path)
        print(f"Found {len(files)} files in {len(files_by_folder)} folders.")
        
        # 对每个文件夹分别处理Trial和Adv文件的顺序
        final_files = []

        # 按文件夹名称排序，确保 Act02_Chapter05 在 Act02_Chapter06 之前处理
        sorted_folders = sorted(files_by_folder.items(), key=lambda x: x[0])

        for folder, folder_files in sorted_folders:
            # 分离该文件夹下的Trial和Adv文件
            trial_files = [f for f in folder_files if "Trial" in str(f)]
            adv_files = [f for f in folder_files if "Trial" not in str(f)]

            # 按文件名排序
            adv_files.sort()
            trial_files.sort()
            
            # Act02_Chapter06 特殊处理（只有Trial，没有Adv）
            if "Act02_Chapter06" in folder:
                print("Special handling for Act02_Chapter06")
                print(f"Adv05_last: {[os.path.basename(str(f)) for f in self.Adv05_last]}")
                folder_final = trial_files + self.Adv05_last
                print(f"Final files for Chapter06: {[os.path.basename(str(f)) for f in folder_final]}")
            
            # 其他章节的正常处理
            elif len(adv_files) >= 2:
                if "Act01_Chapter02" in folder:
                    folder_final = adv_files[:-3] + trial_files + adv_files[-3:]
                elif "Act02_Chapter05" in folder:
                    print("Special handling for Act02_Chapter05")
                    Adv05_first = adv_files[:5]
                    self.Adv05_last = adv_files[5:]
                    folder_final = Adv05_first + trial_files
                    print(f"Adv05 first 5: {[os.path.basename(str(f)) for f in Adv05_first]}")
                    print(f"Adv05 last 4: {[os.path.basename(str(f)) for f in self.Adv05_last]}")
                else:
                    folder_final = adv_files[:-2] + trial_files + adv_files[-2:]
            else:
                folder_final = adv_files + trial_files
            
            final_files.extend(folder_final)
        
        print(f"🚀 Found {len(final_files)} scripts. Starting extraction...")

        for file_path in tqdm(final_files):
            try:
                self.parse_file(str(file_path))
            except Exception as e:
                print(f"❌ Error parsing {file_path}: {e}")
                continue

        with open(output_file, "w", encoding="utf-8") as out_f:
            json.dump(self.data, out_f, ensure_ascii=False, indent=2)

        print(f"\n✅ Extraction complete!")
        print(f"📄 Total segments: {len(self.data)}")
        print(f"💾 Saved to: {output_file}")

if __name__ == "__main__":
    parser = Processor()
    parser.run("E:\\魔裁数据\\Localization\\zh-Hans\\Text\\Scripts", "./new_output.json")

