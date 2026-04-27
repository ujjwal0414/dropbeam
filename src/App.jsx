import { useState } from 'react'
import reactLogo from './assets/react.svg'
import viteLogo from './assets/vite.svg'
import heroImg from './assets/hero.png'
import './App.css'

import { DropBeamv2 } from './p2p-share_v2.jsx'
import { Wrapper } from './dropbeam/components/Wrapper.jsx'
import { DropBeamP2P } from './DropBeamP2P_TailwindDark.jsx'

function App() {
  const [count, setCount] = useState(0)

  return (
   <>
   <DropBeamv2 />
   </>
  )
}

export default App
