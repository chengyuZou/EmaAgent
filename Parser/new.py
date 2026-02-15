"""
数据清洗脚本：简单映射第三周目章节
仅替换 chapter 和 chunk_id 前缀
"""
import json
import re
from pathlib import Path
from typing import Dict, List


class SimpleThirdLoopMapper:
    """第三周目简单映射器"""
    
    CHAPTER_MAPPING = {
        "Act02_Chapter05": "Act03_Chapter01",
        "Act02_Chapter06": "Act03_Chapter02",
    }
    
    CHUNK_PREFIX_MAPPING = {
        "0205": "0301",
        "0206": "0302",
    }
    
    def __init__(self, input_path: str, output_path: str = None):
        self.input_path = Path(input_path)
        self.output_path = Path(output_path) if output_path else self.input_path.parent / f"{self.input_path.stem}_cleaned.json"
        self.data: List[Dict] = []
    
    def load_data(self):
        """加载数据"""
        print(f"📂 加载数据: {self.input_path}")
        with open(self.input_path, 'r', encoding='utf-8') as f:
            self.data = json.load(f)
        print(f"✅ 加载完成，共 {len(self.data)} 条记录")
    
    def map_third_loop(self):
        """映射第三周目数据"""
        print("\n🔄 映射第三周目章节...")
        
        mapped_count = 0
        for item in self.data:
            # 只处理第三周目
            if item.get("timeline") != "3rd_Loop":
                continue
            
            # 获取当前章节
            start_chapter = item.get("start_chapter", "")
            end_chapter = item.get("end_chapter", "")
            
            # 映射章节
            if start_chapter in self.CHAPTER_MAPPING:
                item["start_chapter"] = self.CHAPTER_MAPPING[start_chapter]
                
            if end_chapter in self.CHAPTER_MAPPING:
                item["end_chapter"] = self.CHAPTER_MAPPING[end_chapter]
            
            # 映射 chunk_id 前缀
            start_chunk_id = item.get("start_chunk_id", "")
            end_chunk_id = item.get("end_chunk_id", "")
            
            item["start_chunk_id"] = self._replace_chunk_prefix(start_chunk_id)
            item["end_chunk_id"] = self._replace_chunk_prefix(end_chunk_id)
            
            mapped_count += 1
        
        print(f"✅ 映射完成，共处理 {mapped_count} 条第三周目记录")
    
    def _replace_chunk_prefix(self, chunk_id: str) -> str:
        """替换 chunk_id 的前缀（0205->0301, 0206->0302）"""
        if not chunk_id:
            return chunk_id
        
        # 提取前4位数字前缀
        match = re.match(r'^(\d{4})(.*)', chunk_id)
        if not match:
            return chunk_id
        
        old_prefix, rest = match.groups()
        
        # 查找映射
        new_prefix = self.CHUNK_PREFIX_MAPPING.get(old_prefix, old_prefix)
        
        return f"{new_prefix}{rest}"
    
    def save(self):
        """保存数据"""
        print(f"\n💾 保存数据到: {self.output_path}")
        
        with open(self.output_path, 'w', encoding='utf-8') as f:
            json.dump(self.data, f, ensure_ascii=False, indent=2)
        
        print(f"✅ 保存完成，共 {len(self.data)} 条记录")
    
    def verify(self):
        """验证映射结果"""
        print("\n🔍 验证映射结果:")
        
        third_loop_items = [item for item in self.data if item.get("timeline") == "3rd_Loop"]
        
        # 统计章节分布
        chapter_counts = {}
        for item in third_loop_items:
            chapter = item.get("start_chapter", "Unknown")
            chapter_counts[chapter] = chapter_counts.get(chapter, 0) + 1
        
        print(f"  第三周目章节分布:")
        for chapter, count in sorted(chapter_counts.items()):
            print(f"    {chapter}: {count} 条")
        
        # 检查是否还有旧章节
        old_chapters = ["Act02_Chapter05", "Act02_Chapter06"]
        has_old = any(
            item.get("start_chapter") in old_chapters or item.get("end_chapter") in old_chapters
            for item in third_loop_items
        )
        
        print(f"  是否还有旧章节ID: {'❌ 是' if has_old else '✅ 否'}")
        
        # 检查 chunk_id 前缀
        old_prefixes = ["0205", "0206"]
        has_old_prefix = any(
            any(item.get("start_chunk_id", "").startswith(p) or 
                item.get("end_chunk_id", "").startswith(p) for p in old_prefixes)
            for item in third_loop_items
        )
        
        print(f"  是否还有旧chunk_id前缀: {'❌ 是' if has_old_prefix else '✅ 否'}")
    
    def run(self):
        """执行完整流程"""
        print("="*60)
        print("🔄 第三周目简单映射脚本")
        print("="*60)
        
        self.load_data()
        self.map_third_loop()
        self.save()
        self.verify()
        
        print("\n" + "="*60)
        print("✨ 映射完成！")
        print("="*60)
    
    def print_sample(self, n: int = 3):
        """打印样例数据"""
        third_loop_items = [item for item in self.data if item.get("timeline") == "3rd_Loop"]
        
        print(f"\n📋 第三周目样例数据（前{n}条）:")
        for i, item in enumerate(third_loop_items[:n], 1):
            print(f"\n--- 样例 {i} ---")
            print(f"Chapter: {item.get('start_chapter')} -> {item.get('end_chapter')}")
            print(f"Chunk ID: {item.get('start_chunk_id')} -> {item.get('end_chunk_id')}")
            print(f"Type: {'Trial' if item.get('is_trial') else 'Adv'}")


def main():
    """主函数"""
    input_file = r"D:\EmaAgent\EmaAgent-v0.2\Parser\norm_merged.json"
    output_file = r"D:\EmaAgent\EmaAgent-v0.2\Parser\norm_merged_cleaned.json"
    
    mapper = SimpleThirdLoopMapper(input_file, output_file)
    mapper.run()
    mapper.print_sample(n=5)


if __name__ == "__main__":
    main()