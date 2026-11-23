import type { CameraAction } from '../workspace/viewerActions';

type Point = [number, number, number];
export type CameraPose = { kind: 'pose'; eye: Point; target: Point };
export type ViewCameraAction = CameraAction | CameraPose;

/** 预览链接中的六个米制场景坐标，依次为相机位置与观察点。 */
export function previewPose(search: string): CameraPose | null {
  const raw = new URLSearchParams(search).get('camera');
  if (!raw || raw.length > 192) return null;
  const values = raw.split(',');
  if (values.length !== 6 || values.some((part) => !part.trim())) return null;
  const [x, y, z, tx, ty, tz] = values.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const coordinates = [x, y, z, tx, ty, tz];
  if (
    coordinates.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e8) ||
    Math.hypot(x - tx, y - ty, z - tz) < 0.1
  )
    return null;
  return { kind: 'pose', eye: [x, y, z], target: [tx, ty, tz] };
}
