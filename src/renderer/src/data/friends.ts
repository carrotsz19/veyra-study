import { useCallback, useEffect, useState } from 'react'
import type { FriendSearchCard, FriendsData } from '@shared/types'

const EMPTY: FriendsData = { friends: [], incoming: [], outgoing: [] }

/**
 * Loads and updates your Veyra friends list (shared with Veyra IronLog via
 * the main Veyra account server, so it works even while the group server sleeps).
 */
export function useFriends(enabled: boolean) {
  const [data, setData] = useState<FriendsData>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const reload = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    setError('')
    try {
      const next = await window.veyra.friends.list()
      setData(next)
      setLoaded(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load friends.')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setData(EMPTY)
      setLoaded(false)
      setError('')
      return
    }
    void reload()
  }, [enabled, reload])

  const send = useCallback(async (username: string) => {
    const next = await window.veyra.friends.send(username)
    setData(next)
    setLoaded(true)
    return next
  }, [])

  const respond = useCallback(async (requesterId: string, accept: boolean) => {
    const next = await window.veyra.friends.respond(requesterId, accept)
    setData(next)
    setLoaded(true)
    return next
  }, [])

  const remove = useCallback(async (otherUserId: string) => {
    const next = await window.veyra.friends.remove(otherUserId)
    setData(next)
    setLoaded(true)
    return next
  }, [])

  const search = useCallback((query: string): Promise<FriendSearchCard[]> => {
    return window.veyra.friends.search(query)
  }, [])

  return { data, loaded, loading, error, reload, send, respond, remove, search }
}
