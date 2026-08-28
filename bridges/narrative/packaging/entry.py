# 为 PyInstaller 提供不依赖包内相对执行语义的冻结入口。
from core.main import main


if __name__ == "__main__":
    main()
