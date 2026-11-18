import type { CameraStep } from './cameraNavigation';
import type { CameraPerspective } from './cameraPerspective';

const groups = [
  {
    label: '移动与转向',
    buttons: [
      ['turnLeft', '向左转', '↺'],
      ['forward', '前进', '↑'],
      ['turnRight', '向右转', '↻'],
      ['left', '向左平移', '←'],
      ['back', '后退', '↓'],
      ['right', '向右平移', '→'],
    ],
  },
  {
    label: '高度',
    buttons: [
      ['up', '升高', '↑'],
      ['down', '降低', '↓'],
    ],
  },
  {
    label: '缩放',
    buttons: [
      ['zoomIn', '拉近', '+'],
      ['zoomOut', '拉远', '−'],
    ],
  },
] as const;

export function CameraControls({
  perspective,
  onPerspective,
  onStep,
}: {
  readonly perspective: CameraPerspective;
  readonly onPerspective: (mode: CameraPerspective) => void;
  readonly onStep: (step: CameraStep) => void;
}) {
  return (
    <div className="camera-controls" role="group" aria-label="相机控制器">
      <div className="camera-controls__modes" role="group" aria-label="相机视角">
        {(['first', 'third'] as const).map((mode) => (
          <button
            key={mode}
            type="button"
            aria-pressed={perspective === mode}
            onClick={() => onPerspective(mode)}
          >
            {mode === 'first' ? '第一视角' : '第三视角'}
          </button>
        ))}
      </div>
      <div className="camera-controls__actions">
        {groups.map(({ label, buttons }) => (
          <div key={label} className="camera-controls__group" role="group" aria-label={label}>
            <span aria-hidden="true">{label}</span>
            <div className="camera-controls__keys">
              {buttons.map(([step, name, symbol]) => (
                <button
                  key={step}
                  type="button"
                  aria-label={name}
                  title={name}
                  onClick={() => onStep(step)}
                >
                  {symbol}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
