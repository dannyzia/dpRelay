import React, { createContext, useContext, useEffect, useState } from 'react'
import { onAuthStateChanged } from 'firebase/auth'
import { auth, db, rtdb } from '../utils/firebase'
import { doc, getDoc } from 'firebase/firestore'
import { onValue, ref } from 'firebase/database'

const AuthContext = createContext()

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }) {
  const [currentUser, setCurrentUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [userRole, setUserRole] = useState(null)
  const [bulkEnabled, setBulkEnabled] = useState(false)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      setCurrentUser(user)
      if (user) {
        try {
          const idTokenResult = await user.getIdTokenResult(true)
          if (idTokenResult.claims?.admin) {
            setUserRole('admin')
          } else {
            const userDoc = await getDoc(doc(db, 'users', user.uid))
            if (userDoc.exists()) {
              setUserRole(userDoc.data().role)
            } else {
              setUserRole('client')
            }
          }
        } catch (error) {
          console.error('Error fetching user role:', error)
          setUserRole('client')
        }
      } else {
        setUserRole(null)
      }
      setLoading(false)
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    const configRef = ref(rtdb, 'config/bulk_enabled')
    const unsubscribeConfig = onValue(configRef, (snapshot) => {
      setBulkEnabled(snapshot.exists() && snapshot.val() === true)
    })

    return () => unsubscribeConfig()
  }, [])

  const value = {
    currentUser,
    userRole,
    loading,
    bulkEnabled,
  }

  return (
    <AuthContext.Provider value={value}>
      {!loading && children}
    </AuthContext.Provider>
  )
}
