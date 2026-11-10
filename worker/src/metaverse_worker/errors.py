"""处理失败的分类。"""


class PermanentJobError(RuntimeError):
    """输入本身不对（不合法、超出上限、引用不到），重试也不会好。"""


class InputRejected(PermanentJobError):
    """解析前检查不通过（设计 6.4）：三角形数、贴图像素、体素格数超限，或文件格式不认识。"""
