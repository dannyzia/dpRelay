import React from 'react'

const FeatureCard = ({ title, description, icon }) => {
  return (
    <div className="bg-white border border-gray-100 rounded-xl p-6 hover:shadow-md transition-shadow">
      <div className="text-4xl mb-4">{icon}</div>
      <h3 className="text-lg font-semibold text-gray-900 mb-2">{title}</h3>
      <p className="text-gray-600 text-sm leading-relaxed">{description}</p>
    </div>
  )
}

export default FeatureCard
