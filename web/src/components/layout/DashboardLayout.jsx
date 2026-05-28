import React from 'react'
import { Outlet } from 'react-router-dom'
import ClientSidebar from './ClientSidebar'

const DashboardLayout = () => {
  return (
    <div className="flex min-h-screen bg-gray-50">
      <ClientSidebar />
      <main className="flex-1 ml-64 p-8 pb-24">
        <Outlet />
      </main>
    </div>
  )
}

export default DashboardLayout
