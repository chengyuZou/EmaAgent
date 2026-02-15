"""
游戏路由模块

该模块提供拼图游戏图片列表与上传接口
"""

from typing import List

from fastapi import APIRouter, UploadFile, File, HTTPException
from pydantic import BaseModel

from api.services.game_service import game_service


router = APIRouter()


class BatchDeleteImagesRequest(BaseModel):
    """
    批量删除拼图图片请求模型
    """

    items: List[str]


@router.get("/images", response_model=List[str])
async def get_images():
    """
    获取拼图图片地址列表

    Args:
        None

    Returns:
        List[str]: 拼图图片地址列表
    """
    # 由服务层统一返回可用图片资源
    return game_service.get_puzzle_images()


@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """
    上传图片到拼图图库

    Args:
        file (UploadFile): 用户上传文件

    Returns:
        Dict[str str]: 上传后文件地址与文件名

    Raises:
        HTTPException: 当上传文件不是图片时抛出 400
    """
    # 只允许 image/* 类型文件
    if not file.content_type.startswith("image/"):
        raise HTTPException(400, "仅支持图片文件")

    # 委托服务层保存文件并返回访问地址
    url = await game_service.save_uploaded_image(file)
    return {"url": url, "filename": file.filename}


@router.delete("/image/{filename}")
async def delete_image(filename: str):
    """
    删除单张拼图图片

    Args:
        filename (str): 图片文件名

    Returns:
        Dict[str str]: 删除结果
    """
    if game_service.delete_image(filename):
        return {"status": "deleted", "filename": filename}
    raise HTTPException(404, "图片不存在")


@router.post("/images/delete")
async def batch_delete_images(body: BatchDeleteImagesRequest):
    """
    批量删除拼图图片

    Args:
        body (BatchDeleteImagesRequest): 批量删除请求

    Returns:
        Dict[str Any]: 批量删除结果
    """
    result = game_service.delete_images(body.items)
    return {
        "status": "ok",
        "removed": result["removed"],
        "missing": result["missing"],
        "removed_count": len(result["removed"]),
        "missing_count": len(result["missing"]),
    }
