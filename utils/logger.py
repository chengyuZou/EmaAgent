"""全局日志管理器"""
import logging
import os
import time
import inspect
from pathlib import Path
from colorama import Fore, Style, init

# 初始化 colorama 以支持 Windows 终端颜色
init(autoreset=True)


def _get_default_log_dir() -> str:
    """获取默认日志目录（延迟加载，避免循环导入）"""
    try:
        from config.paths import get_paths
        return str(get_paths().logs_dir)
    except Exception:
        # 未初始化路径配置时回退项目默认 logs 目录
        return str(Path(__file__).parent.parent / "logs")

class ColoredFormatter(logging.Formatter):
    """
    自定义 Formatter，用于在控制台输出彩色日志
    """
    # 定义颜色映射
    COLORS = {
        'DEBUG': Fore.CYAN,
        'INFO': Fore.GREEN,
        'WARNING': Fore.YELLOW,
        'ERROR': Fore.RED,
        'CRITICAL': Fore.RED + Style.BRIGHT,
    }

    def format(self, record):
        # 获取日志级别对应的颜色
        color = self.COLORS.get(record.levelname, Fore.WHITE)
        # 格式化时间
        asctime = self.formatTime(record, self.datefmt)
        # 获取调用者的函数名 (record.funcName 有时可能不准确，这里作为备用)
        func_name = record.funcName
        
        # 构建彩色输出字符串
        # 格式: [时间] [级别] [函数名:行号] - 消息
        log_fmt = (
            f"{Fore.WHITE}[{asctime}]{Style.RESET_ALL} "
            f"{color}[{record.levelname}]{Style.RESET_ALL} "
            f"{Fore.MAGENTA}[{func_name}:{record.lineno}]{Style.RESET_ALL} - "
            f"{record.getMessage()}"
        )
        return log_fmt

class GlobalLogger:
    _instance = None
    _logger = None
    _log_to_file = True  # 默认生成日志文件
    _log_dir_root = None  # 日志根目录（延迟初始化）

    def __new__(cls, *args, **kwargs):
        if not cls._instance:
            cls._instance = super(GlobalLogger, cls).__new__(cls)
            cls._instance._initialize_logger()
        return cls._instance

    def _initialize_logger(self):
        """初始化 logger 实例"""
        self._logger = logging.getLogger("GlobalAppLogger")
        self._logger.setLevel(logging.DEBUG)
        self._logger.propagate = False  # 防止重复打印
        
        # 延迟获取日志目录
        if self._log_dir_root is None:
            self._log_dir_root = _get_default_log_dir()

        # 1. 控制台 Handler (带颜色)
        console_handler = logging.StreamHandler()
        console_handler.setLevel(logging.DEBUG) # 控制台显示的最低级别
        console_handler.setFormatter(ColoredFormatter(datefmt="%Y-%m-%d %H:%M:%S"))
        self._logger.addHandler(console_handler)

    def set_file_logging(self, enable: bool, root_dir: str = "logs"):
        """
        配置是否启用文件日志及存储路径
        """
        self._log_to_file = enable
        self._log_dir_root = root_dir

    def _get_file_handler(self):
        """
        动态获取文件 Handler，确保按天生成文件夹
        """
        if not self._log_to_file:
            return None

        # 获取当前日期，构建路径 logs/2024-05-20/
        current_date = time.strftime("%Y-%m-%d")
        daily_log_dir = os.path.join(self._log_dir_root, current_date)
        
        if not os.path.exists(daily_log_dir):
            os.makedirs(daily_log_dir)

        # 日志文件名: app.log (或者带上时间戳 app_14-30-00.log)
        # 这里选择追加到当天的 app.log 中
        log_file_path = os.path.join(daily_log_dir, "app.log")

        file_handler = logging.FileHandler(log_file_path, encoding='utf-8')
        file_handler.setLevel(logging.DEBUG)
        
        # 文件日志不需要颜色，使用标准格式
        # 格式: 2024-05-20 14:30:00 - INFO - [main:45] - 消息内容
        formatter = logging.Formatter(
            fmt='%(asctime)s - %(levelname)s - [%(funcName)s:%(lineno)d] - %(message)s',
            datefmt='%Y-%m-%d %H:%M:%S'
        )
        file_handler.setFormatter(formatter)
        return file_handler

    def _log(self, level, message, *args):
        """
        核心日志记录函数
        为了获取正确的调用者函数名（而不是 log_info），我们需要回溯堆栈
        """
        # 获取调用者的栈帧
        # stack[0] 是 _log, stack[1] 是 info/error, stack[2] 是实际调用者
        caller_frame = inspect.stack()[2]
        caller_func_name = caller_frame.function
        caller_lineno = caller_frame.lineno
        
        # 临时创建一个 LogRecord 来覆盖 funcName 和 lineno
        # 注意：这里我们通过 extra 字典或者直接修改 record 比较麻烦
        # 简单方法：直接在 message 里带上信息，或者使用 logging 的 makeRecord
        # 但为了配合上面的 Formatter，我们使用 `extra` 传递信息比较复杂
        # 这里的实现为了保持 Formatter 简单，我们利用 `findCaller` 机制的变通方法
        # 或者更简单的：我们直接用 `self._logger` 记录，但需要修正栈层级
        
        # 修正：logging 库支持 `stacklevel` 参数 (Python 3.8+)
        # stacklevel=2 表示跳过 _log 和 info/debug 这一层
        
        if self._log_to_file:
            # 每次写日志时检查/创建文件 Handler (略有性能损耗，但在桌面应用中可忽略)
            # 更好的做法是每天 0 点轮转，但那样逻辑复杂。这里为了简单直接每次检查。
            # 为了避免重复添加 Handler，我们先移除旧的文件 Handler
            handlers_to_remove = [h for h in self._logger.handlers if isinstance(h, logging.FileHandler)]
            for h in handlers_to_remove:
                self._logger.removeHandler(h)
            
            file_handler = self._get_file_handler()
            if file_handler:
                self._logger.addHandler(file_handler)

        if level == 'info':
            self._logger.info(message, *args, stacklevel=3)
        elif level == 'debug':
            self._logger.debug(message, *args, stacklevel=3)
        elif level == 'warning':
            self._logger.warning(message, *args, stacklevel=3)
        elif level == 'error':
            self._logger.error(message, *args, stacklevel=3)
        elif level == 'critical':
            self._logger.critical(message, *args, stacklevel=3)

    # --- 公共接口 ---
    def info(self, msg, *args):
        self._log('info', msg, *args)

    def debug(self, msg, *args):
        self._log('debug', msg, *args)

    def warning(self, msg, *args):
        self._log('warning', msg, *args)

    def error(self, msg, *args, **kwargs):  # 修改为接受关键字参数
        """
        记录错误日志
        Args:
            msg: 日志消息
            *args: 格式化参数
            **kwargs: 关键字参数，如 exc_info
        """
        exc_info = kwargs.get('exc_info')
        if exc_info:
            # 如果需要异常信息，则获取当前异常
            import sys
            exc_type, exc_value, exc_traceback = sys.exc_info()
            if exc_type:
                # 包含异常信息
                formatted_msg = str(msg) + f"\n{exc_value}"
                self._log('error', formatted_msg, *args)
            else:
                self._log('error', msg, *args)
        else:
            self._log('error', msg, *args)
        
    def critical(self, msg, *args):
        self._log('critical', msg, *args)

    def exception(self, msg, *args):
        """
        记录异常日志
        Args:
            msg: 日志消息
            *args: 格式化参数
        """
        import sys
        exc_type, exc_value, exc_traceback = sys.exc_info()
        if exc_type:
            formatted_msg = str(msg) + f"\n{exc_value}"
            self._log('error', formatted_msg, *args)
        else:
            self._log('error', msg, *args)

# 创建全局单例
logger = GlobalLogger()

# 示例测试代码 (仅当直接运行此文件时执行)
if __name__ == "__main__":
    def test_func():
        logger.info("这是一条普通信息")
        logger.warning("这是一条警告，注意！")
        logger.error("发生了一个错误: %s", "File not found")
        logger.debug("调试变量 x = 10")

    # 启用文件日志
    logger.set_file_logging(True)
    
    print("开始测试 Logger...")
    test_func()
    print("测试完成，请检查 logs 文件夹。")
