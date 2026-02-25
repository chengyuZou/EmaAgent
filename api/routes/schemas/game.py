from typing import List

from pydantic import BaseModel


class BatchDeleteImagesRequest(BaseModel):
    """
    批量删除拼图图片请求模型

    - items (List[str]): 待删除文件名列表
    """

    items: List[str]
