import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({plugins:[react()],server:{proxy:{'/api':{target:'http://localhost:4316',changeOrigin:true},'/openapi.json':'http://localhost:4316'}}});
