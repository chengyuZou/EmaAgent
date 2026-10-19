import { createRoot } from 'react-dom/client';
import { Live2DStage } from '../../../src/live2d-react/Live2DStage.js';

const host = document.getElementById('root')!;

void fetch('/model.zip').then(response => response.blob()).then(modelArchive => {
  createRoot(host).render(
    <Live2DStage
      modelArchive={modelArchive}
      onReady={() => { host.dataset.ready = 'true'; }}
      onError={error => { host.dataset.error = error.message; }}
      onDiagnostic={event => {
        if (event === 'first_tick') host.dataset.firstTick = 'true';
      }}
    />,
  );
}).catch((error: unknown) => {
  host.dataset.error = String(error);
});
