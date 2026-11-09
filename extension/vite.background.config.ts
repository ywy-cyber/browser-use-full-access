import { targetBuild } from './vite.shared.ts'

export default targetBuild('src/background/lite.ts', 'es', 'background.js', true)
