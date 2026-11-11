import { useEffect, useState } from 'react'

/** Phone-sized screen, held either way (the Android app, or a very narrow window). */
const query = '(max-width: 720px), (max-height: 540px) and (pointer: coarse)'
export const isPhone = () => matchMedia(query).matches

export function usePhone(): boolean {
  const [phone, setPhone] = useState(isPhone)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setPhone(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return phone
}

/** The Android app (some computer-only features are hidden there). */
export const onAndroid = () => document.documentElement.classList.contains('phone')
