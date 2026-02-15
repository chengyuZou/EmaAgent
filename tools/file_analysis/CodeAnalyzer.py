import ast
import re
import os
from typing import Dict, Any, List, Optional
from pathlib import Path
from dataclasses import dataclass
import logging

from ..base import BaseTool
from tools.base import ToolResult, ToolFailure

from utils.logger import logger

class CodeAnalysisTool(BaseTool):
    """
    智能代码分析工具
    使用 AST (Python) 和 正则 (其他语言) 快速提取代码结构、复杂度和元数据。
    """

    name: str = "analyze_code"
    description: str = "分析代码文件。对于Python使用AST精准分析，其他语言使用正则提取结构。返回代码内容、函数/类列表及复杂度评估。"
    parameters: dict = {
        "type": "object",
        "properties": {
            "file_path": {
                "type": "string",
                "description": "代码文件的本地路径"
            }
        },
        "required": ["file_path"]
    }

    async def execute(self, file_path: str) -> ToolResult:
        path = Path(file_path)
        if not path.exists():
            return ToolFailure(error=f"文件不存在: {file_path}")

        try:
            # 读取文件内容
            with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                content = f.read()

            file_ext = path.suffix.lower()
            analysis_result = {}
            
            # 策略分发：Python用AST，其他用正则
            if file_ext == '.py':
                analysis_result = self._analyze_python_ast(content)
            else:
                analysis_result = self._analyze_general_regex(content, file_ext)

            # 构造返回结果
            # System: 放置结构化数据（大纲），帮助 Agent 快速理解架构
            # Output: 放置具体代码内容
            
            structure_summary = self._format_structure_summary(analysis_result)
            
            system_msg = (
                f"文件: {path.name} ({analysis_result.get('language', 'Unknown')})\n"
                f"【代码结构大纲】\n{structure_summary}\n"
                f"【复杂度指标】\n"
                f"- 总行数: {analysis_result['metrics']['total_lines']}\n"
                f"- 代码行: {analysis_result['metrics']['code_lines']}\n"
                f"- 复杂度估算: {analysis_result['metrics'].get('complexity_score', 0)}"
            )

            return ToolResult(output=content, system=system_msg)

        except Exception as e:
            logger.error(f"代码分析失败: {e}", exc_info=True)
            return ToolFailure(error=f"分析失败: {str(e)}")

    def _analyze_python_ast(self, code: str) -> Dict[str, Any]:
        """使用 AST 深度分析 Python 代码"""
        try:
            tree = ast.parse(code)
        except SyntaxError as e:
            return {
                "language": "Python",
                "structure": {"classes": [], "functions": [], "imports": []},
                "metrics": {"total_lines": len(code.splitlines()), "code_lines": 0, "error": str(e)}
            }

        structure = {
            "imports": [],
            "classes": [],
            "functions": []
        }
        
        # 遍历 AST 节点
        for node in ast.walk(tree):
            # 提取导入
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                if isinstance(node, ast.Import):
                    names = [n.name for n in node.names]
                else:
                    module = node.module or ""
                    names = [f"{module}.{n.name}" for n in node.names]
                structure["imports"].extend(names)
            
            # 提取类
            elif isinstance(node, ast.ClassDef):
                methods = [n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
                structure["classes"].append({
                    "name": node.name,
                    "methods": methods,
                    "docstring": ast.get_docstring(node)
                })
            
            # 提取顶层函数
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                # 简单判断是否为顶层函数（不太严谨但在 walk 中够用，或者只在 Module 层级遍历）
                # 这里为了简化，我们假设所有遍历到的函数都记录，但 Agent 自会区分
                if hasattr(node, 'name'): 
                     # 这里其实会包含类方法，若要严格区分需递归处理，但作为概览足够
                    pass 

        # 为了更清晰的结构，我们重新只遍历顶层节点
        top_structure = {"classes": [], "functions": [], "imports": structure["imports"]}
        for node in tree.body:
            if isinstance(node, ast.ClassDef):
                methods = [n.name for n in node.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
                top_structure["classes"].append({"name": node.name, "methods": methods})
            elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                top_structure["functions"].append({"name": node.name})

        # 计算复杂度指标
        lines = code.splitlines()
        metrics = {
            "total_lines": len(lines),
            "code_lines": len([l for l in lines if l.strip() and not l.strip().startswith('#')]),
            "complexity_score": code.count('if ') + code.count('for ') + code.count('while ')
        }

        return {
            "language": "Python",
            "structure": top_structure,
            "metrics": metrics
        }

    def _analyze_general_regex(self, code: str, ext: str) -> Dict[str, Any]:
        """使用正则分析其他语言 (Java, JS, C++, Go)"""
        
        # 定义通用的正则模式
        patterns = {
            ".java": {
                "lang": "Java",
                "class": r'class\s+(\w+)',
                "method": r'(public|private|protected)?\s*\w+\s+(\w+)\s*\(',
            },
            ".js": {
                "lang": "JavaScript",
                "class": r'class\s+(\w+)',
                "method": r'function\s+(\w+)|const\s+(\w+)\s*=\s*\(|(\w+)\s*\(.*\)\s*{',
            },
            ".ts": {
                "lang": "TypeScript",
                "class": r'class\s+(\w+)',
                "method": r'function\s+(\w+)|const\s+(\w+)\s*=\s*\(|(\w+)\s*\(.*\)\s*{',
            },
            ".go": {
                "lang": "Go",
                "class": r'type\s+(\w+)\s+struct',
                "method": r'func\s+(\w+)\s*\(|func\s+\(.*\)\s+(\w+)\s*\(',
            },
            ".cpp": {
                "lang": "C++",
                "class": r'class\s+(\w+)',
                "method": r'\w+\s+(\w+)\s*\(',
            }
        }

        config = patterns.get(ext, {"lang": "Unknown", "class": r'class\s+(\w+)', "method": r'\w+\s+(\w+)\s*\('})
        
        classes = re.findall(config["class"], code)
        # 正则匹配方法可能会匹配到多组，需要展平
        raw_methods = re.findall(config["method"], code)
        functions = []
        for m in raw_methods:
            if isinstance(m, tuple):
                functions.extend([x for x in m if x])
            else:
                functions.append(m)

        metrics = {
            "total_lines": len(code.splitlines()),
            "code_lines": len([l for l in code.splitlines() if l.strip()]),
            "complexity_score": len(re.findall(r'\b(if|for|while|switch|catch)\b', code))
        }

        return {
            "language": config["lang"],
            "structure": {
                "classes": [{"name": c, "methods": []} for c in classes], # 正则很难关联类和方法，暂时分开展示
                "functions": [{"name": f} for f in functions]
            },
            "metrics": metrics
        }

    def _format_structure_summary(self, result: Dict) -> str:
        """将结构化数据格式化为 Agent 易读的字符串"""
        parts = []
        struct = result.get("structure", {})
        
        if struct.get("classes"):
            parts.append("【类定义】:")
            for cls in struct["classes"]:
                methods_str = ", ".join(cls.get("methods", []))
                if methods_str:
                    parts.append(f"  - {cls['name']}: [{methods_str}]")
                else:
                    parts.append(f"  - {cls['name']}")
        
        if struct.get("functions"):
            parts.append("【独立函数】:")
            func_names = [f["name"] for f in struct["functions"]]
            # 如果函数太多，只显示前20个
            if len(func_names) > 20:
                parts.append(f"  - {', '.join(func_names[:20])} ... (共{len(func_names)}个)")
            else:
                parts.append(f"  - {', '.join(func_names)}")
                
        if struct.get("imports"):
            parts.append(f"【依赖库】: {', '.join(struct['imports'][:10])}{'...' if len(struct['imports'])>10 else ''}")

        return "\n".join(parts) if parts else "未检测到明显的类或函数结构。"