import { useState } from 'react'

const steps = [
  {
    title: 'Start with the basics',
    text: 'This template gives you a clean app shell with a dashboard, history, and settings pages.',
  },
  {
    title: 'Swap in your content',
    text: 'Replace the placeholder cards, data model, and views with the business logic for your new app.',
  },
  {
    title: 'Use local demo data',
    text: 'The data layer is backed by localStorage so you can preview the app without a backend.',
  },
  {
    title: 'Deploy easily',
    text: 'Build with Vite and deploy to Vercel, Netlify, or any static host.',
  },
]

export default function Onboarding({ onComplete }) {
  const [stepIndex, setStepIndex] = useState(0)
  const isLast = stepIndex === steps.length - 1

  return (
    <main className="onboarding-page">
      <section className="card onboarding-card">
        <p className="eyebrow">Step {stepIndex + 1} of {steps.length}</p>
        <h1>{steps[stepIndex].title}</h1>
        <p>{steps[stepIndex].text}</p>

        <div className="onboarding-actions">
          {stepIndex > 0 && (
            <button type="button" className="secondary-button" onClick={() => setStepIndex((prev) => prev - 1)}>
              Back
            </button>
          )}
          <button type="button" className="primary-button" onClick={() => {
            if (isLast) {
              onComplete()
            } else {
              setStepIndex((prev) => prev + 1)
            }
          }}>
            {isLast ? 'Get started' : 'Next'}
          </button>
        </div>
      </section>
    </main>
  )
}
