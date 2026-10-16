import {
  NotificationTemplate,
  CreateNotificationTemplateInput,
  UpdateNotificationTemplateInput,
} from '../types/notificationTemplate';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000/api';

export const templatesApi = {
  async getAll(): Promise<NotificationTemplate[]> {
    const response = await fetch(`${API_BASE}/templates`);
    if (!response.ok) throw new Error('Failed to fetch templates');
    return response.json();
  },

  async getById(id: string): Promise<NotificationTemplate> {
    const response = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error('Failed to fetch template');
    return response.json();
  },

  async create(input: CreateNotificationTemplateInput): Promise<NotificationTemplate> {
    const response = await fetch(`${API_BASE}/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('Failed to create template');
    return response.json();
  },

  async update(id: string, input: UpdateNotificationTemplateInput): Promise<NotificationTemplate> {
    const response = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error('Failed to update template');
    return response.json();
  },

  async delete(id: string): Promise<void> {
    const response = await fetch(`${API_BASE}/templates/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw new Error('Failed to delete template');
  },
};
