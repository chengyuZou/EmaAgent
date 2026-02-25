"""
Game routes.
"""

from typing import List

from fastapi import APIRouter, File, HTTPException, UploadFile

from api.routes.schemas.game import BatchDeleteImagesRequest
from api.services.game_service import game_service

router = APIRouter()


@router.get("/images", response_model=List[str])
async def get_images():
    """
    获取拼图图片地址列表
    """
    return game_service.get_puzzle_images()


@router.post("/upload")
async def upload_image(file: UploadFile = File(...)):
    """
    上传图片到拼图图库
    """
    if not file.content_type.startswith("image/"):
        raise HTTPException(400, "仅支持图片文件")

    url = await game_service.save_uploaded_image(file)
    return {"url": url, "filename": file.filename}


@router.delete("/image/{filename}")
async def delete_image(filename: str):
    """
    删除单张拼图图片
    """
    if game_service.delete_image(filename):
        return {"status": "deleted", "filename": filename}
    raise HTTPException(404, "图片不存在")


@router.post("/images/delete")
async def batch_delete_images(body: BatchDeleteImagesRequest):
    """
    批量删除拼图图片
    """
    result = game_service.delete_images(body.items)
    return {
        "status": "ok",
        "removed": result["removed"],
        "missing": result["missing"],
        "removed_count": len(result["removed"]),
        "missing_count": len(result["missing"]),
    }
