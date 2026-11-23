import { expect, it } from 'vitest';
import { previewPose } from './cameraPose';

it('解析米制机位并保留负高度', () => {
  expect(
    previewPose('?view=extended&camera=208.794,-58.343,520.862,206.415,-58.654,645.22'),
  ).toEqual({
    kind: 'pose',
    eye: [208.794, -58.343, 520.862],
    target: [206.415, -58.654, 645.22],
  });
});

it.each(['', '1,2,3', '0,,0,2,3,4', '0,0,0,0,0,0', '3,4,5,NaN,2,2', '0,1,2,1e309,2,3'])(
  '无效的链接机位沿用场景的初始镜头 %j',
  (camera) => {
    expect(previewPose('?camera=' + camera)).toBeNull();
  },
);
