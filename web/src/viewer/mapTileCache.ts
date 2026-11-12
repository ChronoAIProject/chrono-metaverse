import type { SourceCache } from '../core/externalSource';
import { externalResponse, EXTERNAL_RESOURCE_CACHE } from './externalResource';

export const MAP_TILE_CACHE = EXTERNAL_RESOURCE_CACHE;

export async function mapTileImage(
  url: string,
  signal: AbortSignal,
  policy?: SourceCache,
): Promise<ImageBitmap> {
  const response = await externalResponse(url, signal, policy, 8 * 1024 * 1024);
  const image = await createImageBitmap(await response.blob(), { imageOrientation: 'flipY' });
  if (image.width > 2048 || image.height > 2048) {
    image.close();
    throw new Error('地图瓦片尺寸超过 2048 像素');
  }
  return image;
}
