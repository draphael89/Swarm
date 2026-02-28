/** @vitest-environment jsdom */

import { getByRole, getByTitle, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import type { AgentDescriptor, AgentStatus } from '@middleman/protocol'

function manager(
  agentId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    agentId,
    managerId: agentId,
    displayName: agentId,
    role: 'manager',
    status: 'idle',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    cwd: '/tmp',
    model: {
      provider: 'openai-codex',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
      ...modelOverrides,
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(
  agentId: string,
  managerId: string,
  modelOverrides: Partial<AgentDescriptor['model']> = {},
): AgentDescriptor {
  return {
    ...manager(agentId, modelOverrides),
    managerId,
    role: 'worker',
  }
}

let container: HTMLDivElement
let root: Root | null = null

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
})

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount()
    })
  }

  root = null
  container.remove()
})

function click(element: HTMLElement): void {
  flushSync(() => {
    element.click()
  })
}

function renderSidebar({
  agents,
  selectedAgentId = null,
  onSelectAgent = vi.fn(),
  onDeleteAgent = vi.fn(),
  onDeleteManager = vi.fn(),
  onOpenSettings = vi.fn(),
  isSettingsActive = false,
  statuses = {},
}: {
  agents: AgentDescriptor[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onOpenSettings?: () => void
  isSettingsActive?: boolean
  statuses?: Record<string, { status: AgentStatus; pendingCount: number }>
}) {
  root = createRoot(container)

  flushSync(() => {
    root?.render(
      createElement(AgentSidebar, {
        connected: true,
        agents,
        statuses,
        selectedAgentId,
        onAddManager: vi.fn(),
        onSelectAgent,
        onDeleteAgent,
        onDeleteManager,
        onOpenSettings,
        isSettingsActive,
      }),
    )
  })
}

describe('AgentSidebar', () => {
  it('keeps workers collapsed by default and toggles expand/collapse per manager', () => {
    renderSidebar({ agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')] })

    expect(queryByText(container, 'worker-alpha')).toBeNull()

    click(getByRole(container, 'button', { name: 'Expand manager manager-alpha' }))
    expect(queryByText(container, 'worker-alpha')).toBeTruthy()

    click(getByRole(container, 'button', { name: 'Collapse manager manager-alpha' }))
    expect(queryByText(container, 'worker-alpha')).toBeNull()
  })

  it('shows runtime icons for supported model presets', () => {
    renderSidebar({
      agents: [
        manager('manager-pi', { provider: 'openai-codex', modelId: 'gpt-5.3-codex' }),
        worker('worker-opus', 'manager-pi', { provider: 'anthropic', modelId: 'claude-opus-4-6' }),
        worker('worker-codex', 'manager-pi', { provider: 'openai-codex-app-server', modelId: 'default' }),
      ],
    })

    click(getByRole(container, 'button', { name: 'Expand manager manager-pi' }))

    expect(container.querySelectorAll('img[src="/pi-logo.svg"]').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelectorAll('img[src="/agents/codex-logo.svg"]').length).toBeGreaterThanOrEqual(2)
    expect(container.querySelectorAll('img[src="/agents/claude-logo.svg"]').length).toBeGreaterThanOrEqual(1)
    expect(container.querySelectorAll('img[src="/agents/codex-app-logo.svg"]').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps manager selection behavior working while collapse state changes', () => {
    const onSelectAgent = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onSelectAgent,
    })

    const getManagerRowButton = () => getByTitle(container, 'manager-alpha') as HTMLButtonElement
    expect(getManagerRowButton()).toBeTruthy()

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')

    click(getByRole(container, 'button', { name: 'Expand manager manager-alpha' }))
    expect(onSelectAgent).toHaveBeenCalledTimes(1)

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(2)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('renders context-menu delete affordances for managers and workers', () => {
    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
    })

    const managerRow = getByTitle(container, 'manager-alpha').closest('[data-slot="context-menu-trigger"]')
    expect(managerRow).toBeTruthy()
    expect(managerRow?.getAttribute('data-state')).toBe('closed')

    click(getByRole(container, 'button', { name: 'Expand manager manager-alpha' }))
    const workerRow = getByTitle(container, 'worker-alpha').closest('[data-slot="context-menu-trigger"]')
    expect(workerRow).toBeTruthy()
    expect(workerRow?.getAttribute('data-state')).toBe('closed')
  })

  it('calls onOpenSettings when the settings button is clicked', () => {
    const onOpenSettings = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha')],
      onOpenSettings,
    })

    click(getByRole(container, 'button', { name: 'Settings' }))
    expect(onOpenSettings).toHaveBeenCalledTimes(1)
  })

})
