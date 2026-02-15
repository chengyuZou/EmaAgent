import json
from typing import List, Dict
import re

class ScriptMerger:
    def __init__(self, window_size=6, overlap=2):
        """
        window_size: 每个块包含多少句对话 (建议 5-10 句)
        overlap: 相邻块重叠多少句 (保证上下文连续性)
        """
        self.window_size = window_size
        self.overlap = overlap
    
    def _extract_trial_info(self, chunk_id: str) -> int:
        """从 chunk_id 提取 Trial 序号"""
        # 例如: "0204Trial06_Hanna006->0204Trial07_Miria002"
        trial_match = re.search(r'Trial(\d+)', chunk_id)

        return int(trial_match.group(1)) if trial_match else 0
    
    def _extract_adv_info(self, chunk_id: str) -> int:
        """从 chunk_id 提取 Adv 序号"""
        # 例如: "0101Adv02_Ema003->0101Adv02_Ema013"
        # 提取起始的 Adv 编号
        adv_match = re.search(r'Adv(\d+)', chunk_id)
        return int(adv_match.group(1)) if adv_match else 0
    
    def _normalize_progress_by_chapter(self, merged_data: List[Dict]) -> List[Dict]:
        """按章节归一化 progress_score"""

        # 按章节分组
        chapter_groups: Dict[str, List[Dict]] = {}
        for item in merged_data:
            chapter_key = item['start_chapter']  # 取起始章节
            if chapter_key not in chapter_groups:
                chapter_groups[chapter_key] = []
            chapter_groups[chapter_key].append(item)

        # 逐章节处理
        for chapter, items in chapter_groups.items():
            # 分离 Trial 和 Adv
            trial_items = [item for item in items if item.get('is_trial', False)]
            adv_items = [item for item in items if not item.get('is_trial', False)]

            # 处理 Trial 部分
            if trial_items:
                max_trial = max(item['trial_index'] for item in trial_items)
                for item in trial_items:
                    item['progress_score'] = item['trial_index'] / max_trial if max_trial > 0 else 0.0

            # 💡 处理 Adv 部分
            if adv_items:
                # 找出该章节最大的 Adv 编号
                max_adv = max(item['adv_index'] for item in adv_items)
                for item in adv_items:
                    # 归一化到 0-1 区间
                    item['progress_score'] = item['adv_index'] / max_adv if max_adv > 0 else 0.0

        return merged_data


    def merge_dialogues(self, input_file: str, output_file: str):
        with open(input_file, 'r', encoding='utf-8') as f:
            raw_data = json.load(f)

        merged_data = []
        
        # 1. 按周目分组,共三个周目
        grouped_by_file = {}
        for item in raw_data:
            timeline = item['timeline']
            if timeline not in grouped_by_file:
                grouped_by_file[timeline] = []
            grouped_by_file[timeline].append(item)

        # 2. 执行滑动窗口合并
        for timeline, items in grouped_by_file.items():
            total_items = len(items)
            # 使用步长 step = window_size - overlap
            step = self.window_size - self.overlap
            
            for i in range(0, total_items, step):
                # 获取当前窗口的切片
                window_items = items[i : i + self.window_size]
                if not window_items:
                    break
                
                # 构建合并后的文本块
                # 格式：[角色]: 台词
                context_text = ""
                speakers = set()
                start_id = window_items[0]['id']
                end_id = window_items[-1]['id']

                start_chapter = window_items[0]['chapter']
                end_chapter = window_items[-1]['chapter']

                start_type = window_items[0]['type']
                end_type = window_items[-1]['type']
                is_trial = (start_type == "Trial" or end_type == "Trial")
                
                # 每个单元 JSON
                for item in window_items:
                    # 拼接文本，保留换行
                    line = f"{item['speaker']}: {item['text']}\n"
                    context_text += line
                    speakers.add(item['speaker'])


                adv_index = self._extract_adv_info(start_id)
                trial_index = self._extract_trial_info(start_id)

                # 3. 构造新的 Chunk 对象
                # 这个 Chunk 包含了丰富的上下文，不仅知道说了什么，还知道前因后果
                merged_chunk = {
                    "timeline": timeline,
                    "start_chunk_id": start_id,
                    "end_chunk_id": end_id,
                    "start_chapter": start_chapter,
                    "end_chapter": end_chapter,
                    "is_trial": is_trial,
                    "speakers": list(speakers), # 元数据：包含哪些角色
                    "content": context_text.strip(), # 核心：用于 Embedding 的长文本
                    "adv_index": adv_index,
                    "trial_index": trial_index, # 元数据：Trial 序号
                    "progress_score": 0.0,
                }
                merged_data.append(merged_chunk)
        
        # 按章节归一化
        merged_data = self._normalize_progress_by_chapter(merged_data)

        # 保存结果
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(merged_data, f, ensure_ascii=False, indent=2)
        
        print(f"✅ 合并完成！原数据 {len(raw_data)} 条 -> 合并后 {len(merged_data)} 个剧情块。")

# --- 运行逻辑 ---
if __name__ == "__main__":
    merger = ScriptMerger(window_size=40, overlap=8)
    # 输入你之前生成的 fixed_dialogues.json
    merger.merge_dialogues("new_output.json", "norm_merged.json")