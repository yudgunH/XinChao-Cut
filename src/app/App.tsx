import { HomeScreen } from '@components/home/HomeScreen'
import { useUIStore } from '@store/ui-store'

import { Editor } from './Editor'

export function App() {
  const view = useUIStore((s) => s.view)
  return view === 'home' ? <HomeScreen /> : <Editor />
}
