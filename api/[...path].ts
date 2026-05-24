import { createApp } from '../lib/app';

const app = createApp();

export default app;

export const config = {
  api: {
    bodyParser: false
  }
};
