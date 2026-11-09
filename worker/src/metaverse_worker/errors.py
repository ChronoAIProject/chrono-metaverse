"""任务失败的分类：可重试 / 不可重试。"""


class PermanentJobError(RuntimeError):
    """不可重试的失败（输入不合法、超出上限、空间不存在等）：直接把任务标记为失败。"""


class InputRejected(PermanentJobError):
    """解析前检查不通过（设计 6.4）：三角形数、贴图像素、体素格数超限，或文件格式不认识。"""


# 子进程里抛出这些类型时，按不可重试处理（子进程只传回类型名）。
PERMANENT_ERROR_TYPES = frozenset({"PermanentJobError", "InputRejected"})
