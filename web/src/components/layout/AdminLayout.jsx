import React from 'react'
import { Outlet } from 'react-router-dom'
import AdminSidebar from './AdminSidebar'

const AdminLayout = () => {
  return (
    <div className="flex min-h-screen bg-gray-900">
      <AdminSidebar />
      <main className="flex-1 ml-64 p-8 pb-24">
        <Outlet />
      </main>
    </div>
  )
}

export default AdminLayout
