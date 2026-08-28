import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: './' — 상대 경로로 빌드한다.
// 이 앱은 GitHub Pages 의 하위 경로(/aiffel-quests/m05/)에 올라가고,
// 로컬 preview 에서는 루트에서 돈다. 절대 경로로 빌드하면 둘 중 하나가 깨진다.
export default defineConfig({
  base: './',
  plugins: [react()],
})
