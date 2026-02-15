"""
EmaAgentv0.1 启动入口,现已弃用 保留仅供参考
v0.2 入口在api文件夹下的main.py中

职责：
1. 设置 sys.path（唯一允许修改 sys.path 的位置）
2. 初始化路径配置
3. 启动应用
"""
import asyncio
import sys
from pathlib import Path

# ==================== 1. 设置项目根目录到 sys.path ====================
# 这是整个项目中唯一修改 sys.path 的地方
ROOT_DIR = Path(__file__).parent.resolve()
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

# ==================== 2. 初始化路径配置 ====================
from config.paths import init_paths
paths = init_paths(ROOT_DIR)

# ==================== 3. 导入应用模块 ====================
from agent.EmaAgent import EmaAgent
from utils.logger import logger


async def main():
    """主函数"""
    app = EmaAgent()  # ✅ 不再传入 paths，EmaAgent 内部动态获取
    
    print("\n" + "="*60)
    print("🎮 EmaAgent 已启动")
    print("="*60)
    print("💡 使用说明:")
    print("  - 剧情查询: 询问游戏剧情")
    print("  - 功能执行: 搜索、计算、天气等")
    print("  - 闲聊: 随意聊天")
    print("  - 输入 'exit' 退出")
    print("="*60 + "\n")
    
    session_id = "ema"
    
    try:
        while True:
            user_input = input("\n👤 你: ").strip()
            
            if not user_input:
                continue
            
            if user_input.lower() in ["exit", "退出"]:
                print("\n👋 再见！")
                break
            
            result = await app.run(user_input, session_id=session_id)
            
            print(f"\n📊 本次统计:")
            print(f"   ⏱️  耗时: {result['duration']:.2f}s")
            print(f"   🎯 意图: {result['intent']}")
            
    except KeyboardInterrupt:
        print("\n\n👋 再见！")
    finally:
        await app.close()

if __name__ == "__main__":
    asyncio.run(main())