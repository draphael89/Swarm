/** @vitest-environment jsdom */

import { getByRole, getByText, queryByText } from '@testing-library/dom'
import { createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentSidebar } from './AgentSidebar'
import type { AgentDescriptor, AgentStatus } from '@/lib/ws-types'

function manager(agentId: string): AgentDescriptor {
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
      provider: 'openai',
      modelId: 'gpt-5.3-codex',
      thinkingLevel: 'high',
    },
    sessionFile: `/tmp/${agentId}.jsonl`,
  }
}

function worker(agentId: string, managerId: string): AgentDescriptor {
  return {
    ...manager(agentId),
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
  onReboot = vi.fn(),
  statuses = {},
}: {
  agents: AgentDescriptor[]
  selectedAgentId?: string | null
  onSelectAgent?: (agentId: string) => void
  onDeleteAgent?: (agentId: string) => void
  onDeleteManager?: (managerId: string) => void
  onReboot?: () => void
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
        onReboot,
      }),
    )
  })
}

describe('AgentSidebar', () => {
  it('shows workers expanded by default and toggles collapse/expand per manager', () => {
    renderSidebar({ agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')] })

    expect(queryByText(container, 'worker-alpha')).toBeTruthy()

    click(getByRole(container, 'button', { name: 'Collapse manager manager-alpha' }))
    expect(queryByText(container, 'worker-alpha')).toBeNull()

    click(getByRole(container, 'button', { name: 'Expand manager manager-alpha' }))
    expect(queryByText(container, 'worker-alpha')).toBeTruthy()
  })

  it('keeps manager selection behavior working while collapse state changes', () => {
    const onSelectAgent = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onSelectAgent,
    })

    const getManagerRowButton = () => getByText(container, 'manager-alpha').closest('button') as HTMLButtonElement
    expect(getManagerRowButton()).toBeTruthy()

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(1)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')

    click(getByRole(container, 'button', { name: 'Collapse manager manager-alpha' }))
    expect(onSelectAgent).toHaveBeenCalledTimes(1)

    click(getManagerRowButton())
    expect(onSelectAgent).toHaveBeenCalledTimes(2)
    expect(onSelectAgent).toHaveBeenLastCalledWith('manager-alpha')
  })

  it('preserves existing delete controls for managers and workers', () => {
    const onDeleteAgent = vi.fn()
    const onDeleteManager = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha'), worker('worker-alpha', 'manager-alpha')],
      onDeleteAgent,
      onDeleteManager,
    })

    click(getByRole(container, 'button', { name: 'Delete manager manager-alpha' }))
    expect(onDeleteManager).toHaveBeenCalledTimes(1)
    expect(onDeleteManager).toHaveBeenCalledWith('manager-alpha')

    click(getByRole(container, 'button', { name: 'Delete worker-alpha' }))
    expect(onDeleteAgent).toHaveBeenCalledTimes(1)
    expect(onDeleteAgent).toHaveBeenCalledWith('worker-alpha')
  })

  it('calls onReboot when the reboot button is clicked', () => {
    const onReboot = vi.fn()

    renderSidebar({
      agents: [manager('manager-alpha')],
      onReboot,
    })

    click(getByRole(container, 'button', { name: 'Reboot' }))
    expect(onReboot).toHaveBeenCalledTimes(1)
  })
})
