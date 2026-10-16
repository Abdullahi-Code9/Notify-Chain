import { useState } from 'react';
import { TemplatePreviewModal } from '../components/TemplatePreviewModal';
import type { NotificationTemplate } from '../types/template';
import { NotificationType } from '../types/template';

// Sample templates for demonstration
const sampleTemplates: NotificationTemplate[] = [
  {
    id: 'tmpl_discord_001',
    name: 'Task Created Notification',
    type: NotificationType.DISCORD,
    body: JSON.stringify(
      {
        content: '🔔 New task created on NotifyChain!',
        embeds: [
          {
            title: 'Task #{{taskId}} — {{title}}',
            description: '{{description}}',
            color: 5814783,
            fields: [
              { name: 'Reward', value: '{{amount}} {{currency}}', inline: true },
              { name: 'Creator', value: '{{creator}}', inline: true },
            ],
            timestamp: new Date().toISOString(),
          },
        ],
      },
      null,
      2,
    ),
    variables: ['taskId', 'title', 'description', 'amount', 'currency', 'creator'],
    metadata: { category: 'task', priority: 'high' },
    createdAt: new Date('2024-01-15'),
    updatedAt: new Date('2024-01-20'),
  },
  {
    id: 'tmpl_email_001',
    name: 'Submission Approved Email',
    type: NotificationType.EMAIL,
    subject: 'Your task submission was approved',
    body: JSON.stringify(
      {
        subject: 'Your submission for Task #{{taskId}} was approved',
        body: 'Congratulations {{name}}!\n\nYour submission for Task #{{taskId}} has been approved. Your reward of {{amount}} {{currency}} has been released to your wallet.\n\nThank you for your contribution to the NotifyChain platform!',
        html: '<h2>Congratulations {{name}}!</h2><p>Your submission for <strong>Task #{{taskId}}</strong> has been approved.</p><p>Your reward of <strong>{{amount}} {{currency}}</strong> has been released to your wallet.</p><p>Thank you for your contribution to the NotifyChain platform!</p>',
      },
      null,
      2,
    ),
    variables: ['name', 'taskId', 'amount', 'currency'],
    metadata: { category: 'approval', priority: 'high' },
    createdAt: new Date('2024-01-10'),
    updatedAt: new Date('2024-01-18'),
  },
  {
    id: 'tmpl_sms_001',
    name: 'Payment Notification SMS',
    type: NotificationType.SMS,
    body: 'NotifyChain: Task #{{taskId}} payment of {{amount}} {{currency}} sent to your wallet. Check your balance!',
    variables: ['taskId', 'amount', 'currency'],
    metadata: { category: 'payment', priority: 'high' },
    createdAt: new Date('2024-01-12'),
    updatedAt: new Date('2024-01-22'),
  },
  {
    id: 'tmpl_webhook_001',
    name: 'Task Status Webhook',
    type: NotificationType.WEBHOOK,
    body: JSON.stringify(
      {
        event: 'task.status.changed',
        taskId: '{{taskId}}',
        status: '{{status}}',
        timestamp: '{{timestamp}}',
        metadata: {
          userId: '{{userId}}',
          contractAddress: '{{contractAddress}}',
        },
      },
      null,
      2,
    ),
    variables: ['taskId', 'status', 'timestamp', 'userId', 'contractAddress'],
    metadata: { category: 'webhook', priority: 'medium' },
    createdAt: new Date('2024-01-08'),
    updatedAt: new Date('2024-01-25'),
  },
];

export function TemplatePreviewDemoPage() {
  const [selectedTemplate, setSelectedTemplate] = useState<NotificationTemplate | null>(null);
  const [isPreviewOpen, setIsPreviewOpen] = useState(false);

  const handlePreviewClick = (template: NotificationTemplate) => {
    setSelectedTemplate(template);
    setIsPreviewOpen(true);
  };

  const handleClosePreview = () => {
    setIsPreviewOpen(false);
  };

  return (
    <div className="template-demo-page">
      <header className="template-demo-page__header">
        <h1>Notification Template Preview</h1>
        <p>
          Preview notification templates before sending them. Customize template variables to see
          how notifications will appear across different channels.
        </p>
      </header>

      <section className="template-demo-page__content">
        <h2 className="template-demo-page__section-title">Sample Templates</h2>
        <p className="template-demo-page__description">
          Click on any template card to preview how it will render with dynamic variable
          substitution.
        </p>

        <div className="template-grid">
          {sampleTemplates.map((template) => (
            <article
              key={template.id}
              className="template-card"
              onClick={() => handlePreviewClick(template)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  handlePreviewClick(template);
                }
              }}
              tabIndex={0}
              role="button"
              aria-label={`Preview ${template.name} template`}
            >
              <div className="template-card__header">
                <h3 className="template-card__title">{template.name}</h3>
                <span className={`template-card__badge template-card__badge--${template.type}`}>
                  {template.type.toUpperCase()}
                </span>
              </div>

              <div className="template-card__body">
                <div className="template-card__field">
                  <span className="template-card__label">ID:</span>
                  <span className="template-card__value">{template.id}</span>
                </div>

                {template.variables && template.variables.length > 0 && (
                  <div className="template-card__field">
                    <span className="template-card__label">Variables:</span>
                    <span className="template-card__value">
                      {template.variables.length} variable
                      {template.variables.length !== 1 ? 's' : ''}
                    </span>
                  </div>
                )}

                <div className="template-card__field">
                  <span className="template-card__label">Updated:</span>
                  <span className="template-card__value">
                    {template.updatedAt.toLocaleDateString()}
                  </span>
                </div>
              </div>

              <div className="template-card__footer">
                <button
                  className="template-card__button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handlePreviewClick(template);
                  }}
                  type="button"
                >
                  Preview Template
                </button>
              </div>
            </article>
          ))}
        </div>

        <div className="template-demo-page__info">
          <h3>Features</h3>
          <ul>
            <li>✓ Preview templates with dynamic variable substitution</li>
            <li>✓ Support for Discord, Email, SMS, and Webhook notifications</li>
            <li>✓ Real-time variable editing and preview updates</li>
            <li>✓ Display notification metadata and template information</li>
            <li>✓ Responsive design that works across all screen sizes</li>
            <li>✓ Sample variable values with smart defaults</li>
            <li>✓ Raw JSON payload view for debugging</li>
          </ul>
        </div>
      </section>

      {selectedTemplate && (
        <TemplatePreviewModal
          isOpen={isPreviewOpen}
          onClose={handleClosePreview}
          template={selectedTemplate}
        />
      )}
    </div>
  );
}
