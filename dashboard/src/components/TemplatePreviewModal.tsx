import { useState, useMemo } from 'react';
import { Modal } from './Modal';
import type {
  NotificationTemplate,
  TemplateVariableValues,
  DiscordPayload,
  EmailPayload,
  SmsPayload,
  WebhookPayload,
} from '../types/template';
import {
  renderTemplatePayload,
  validateVariables,
  getSampleVariableValues,
  formatNotificationType,
  getNotificationTypeColor,
  extractVariables,
} from '../utils/templateRenderer';

export interface TemplatePreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  template: NotificationTemplate;
}

export function TemplatePreviewModal({ isOpen, onClose, template }: TemplatePreviewModalProps) {
  const templateVariables = useMemo(
    () => template.variables || extractVariables(template.body),
    [template],
  );

  const [variableValues, setVariableValues] = useState<TemplateVariableValues>(() =>
    getSampleVariableValues(template),
  );

  const validation = useMemo(
    () => validateVariables(template, variableValues),
    [template, variableValues],
  );

  const renderedPayload = useMemo(() => {
    if (!validation.valid) {
      return null;
    }
    return renderTemplatePayload(template, variableValues);
  }, [template, variableValues, validation.valid]);

  const handleVariableChange = (varName: string, value: string) => {
    setVariableValues((prev) => ({
      ...prev,
      [varName]: value,
    }));
  };

  const handleReset = () => {
    setVariableValues(getSampleVariableValues(template));
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Template Preview"
      size="large"
      footer={
        <div className="template-preview__footer-actions">
          <button className="button button--secondary" onClick={handleReset} type="button">
            Reset to Samples
          </button>
          <button className="button button--primary" onClick={onClose} type="button">
            Close
          </button>
        </div>
      }
    >
      <div className="template-preview">
        {/* Template Metadata */}
        <section className="template-preview__section">
          <h3 className="template-preview__section-title">Template Information</h3>
          <div className="template-preview__metadata">
            <div className="template-preview__metadata-item">
              <span className="template-preview__label">Name:</span>
              <span className="template-preview__value">{template.name}</span>
            </div>
            <div className="template-preview__metadata-item">
              <span className="template-preview__label">Type:</span>
              <span
                className="template-preview__badge"
                style={{ backgroundColor: getNotificationTypeColor(template.type) }}
              >
                {formatNotificationType(template.type)}
              </span>
            </div>
            <div className="template-preview__metadata-item">
              <span className="template-preview__label">ID:</span>
              <span className="template-preview__value template-preview__value--mono">
                {template.id}
              </span>
            </div>
            <div className="template-preview__metadata-item">
              <span className="template-preview__label">Created:</span>
              <span className="template-preview__value">{template.createdAt.toLocaleString()}</span>
            </div>
            <div className="template-preview__metadata-item">
              <span className="template-preview__label">Updated:</span>
              <span className="template-preview__value">{template.updatedAt.toLocaleString()}</span>
            </div>
          </div>
        </section>

        {/* Variable Inputs */}
        {templateVariables.length > 0 && (
          <section className="template-preview__section">
            <h3 className="template-preview__section-title">
              Template Variables ({templateVariables.length})
            </h3>
            <p className="template-preview__description">
              Customize the variable values to see how the template will render with different data.
            </p>
            <div className="template-preview__variables">
              {templateVariables.map((varName) => (
                <div key={varName} className="template-preview__variable">
                  <label htmlFor={`var-${varName}`} className="template-preview__variable-label">
                    {varName}
                    {validation.missingVariables.includes(varName) && (
                      <span className="template-preview__required">*</span>
                    )}
                  </label>
                  <input
                    id={`var-${varName}`}
                    type="text"
                    className="template-preview__variable-input"
                    value={variableValues[varName] || ''}
                    onChange={(e) => handleVariableChange(varName, e.target.value)}
                    placeholder={`Enter ${varName}`}
                    aria-required={validation.missingVariables.includes(varName)}
                  />
                </div>
              ))}
            </div>
            {!validation.valid && (
              <div className="template-preview__validation-error">
                <strong>Missing required variables:</strong>{' '}
                {validation.missingVariables.join(', ')}
              </div>
            )}
          </section>
        )}

        {/* Preview Output */}
        <section className="template-preview__section">
          <h3 className="template-preview__section-title">Preview</h3>
          {!validation.valid ? (
            <div className="template-preview__placeholder">
              Fill in all required variables to see the preview
            </div>
          ) : (
            <div className="template-preview__output">
              {template.type === 'discord' && renderedPayload && (
                <DiscordPreview payload={renderedPayload as DiscordPayload} />
              )}
              {template.type === 'email' && renderedPayload && (
                <EmailPreview payload={renderedPayload as EmailPayload} />
              )}
              {template.type === 'sms' && renderedPayload && (
                <SmsPreview payload={renderedPayload as SmsPayload} />
              )}
              {template.type === 'webhook' && renderedPayload && (
                <WebhookPreview payload={renderedPayload as WebhookPayload} />
              )}
            </div>
          )}
        </section>

        {/* Raw JSON Output */}
        {validation.valid && renderedPayload && (
          <section className="template-preview__section">
            <h3 className="template-preview__section-title">Raw JSON Payload</h3>
            <pre className="template-preview__json">
              <code>{JSON.stringify(renderedPayload, null, 2)}</code>
            </pre>
          </section>
        )}
      </div>
    </Modal>
  );
}

function DiscordPreview({ payload }: { payload: DiscordPayload }) {
  return (
    <div className="preview-discord">
      <div className="preview-discord__header">
        <div className="preview-discord__avatar">N</div>
        <div className="preview-discord__author">
          <span className="preview-discord__name">NotifyChain Bot</span>
          <span className="preview-discord__timestamp">
            Today at {new Date().toLocaleTimeString()}
          </span>
        </div>
      </div>

      {payload.content && <div className="preview-discord__content">{payload.content}</div>}

      {payload.embeds && payload.embeds.length > 0 && (
        <div className="preview-discord__embeds">
          {payload.embeds.map((embed, idx) => (
            <div
              key={idx}
              className="preview-discord__embed"
              style={{
                borderLeftColor: embed.color
                  ? `#${embed.color.toString(16).padStart(6, '0')}`
                  : '#5865F2',
              }}
            >
              {embed.title && <div className="preview-discord__embed-title">{embed.title}</div>}
              {embed.description && (
                <div className="preview-discord__embed-description">{embed.description}</div>
              )}
              {embed.fields && embed.fields.length > 0 && (
                <div className="preview-discord__embed-fields">
                  {embed.fields.map((field, fieldIdx) => (
                    <div
                      key={fieldIdx}
                      className={`preview-discord__embed-field ${field.inline ? 'preview-discord__embed-field--inline' : ''}`}
                    >
                      <div className="preview-discord__embed-field-name">{field.name}</div>
                      <div className="preview-discord__embed-field-value">{field.value}</div>
                    </div>
                  ))}
                </div>
              )}
              {embed.timestamp && (
                <div className="preview-discord__embed-timestamp">
                  {new Date(embed.timestamp).toLocaleString()}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmailPreview({ payload }: { payload: EmailPayload }) {
  return (
    <div className="preview-email">
      <div className="preview-email__header">
        <div className="preview-email__field">
          <span className="preview-email__label">From:</span>
          <span className="preview-email__value">
            {payload.from || 'notifications@notifychain.com'}
          </span>
        </div>
        <div className="preview-email__field">
          <span className="preview-email__label">To:</span>
          <span className="preview-email__value">{payload.to || 'recipient@example.com'}</span>
        </div>
        <div className="preview-email__field">
          <span className="preview-email__label">Subject:</span>
          <span className="preview-email__value preview-email__subject">{payload.subject}</span>
        </div>
      </div>
      <div className="preview-email__body">
        {payload.html ? (
          <div dangerouslySetInnerHTML={{ __html: payload.html }} />
        ) : (
          <div className="preview-email__text">{payload.body}</div>
        )}
      </div>
    </div>
  );
}

function SmsPreview({ payload }: { payload: SmsPayload }) {
  const charCount = payload.message.length;
  const segmentCount = Math.ceil(charCount / 160);

  return (
    <div className="preview-sms">
      <div className="preview-sms__device">
        <div className="preview-sms__screen">
          <div className="preview-sms__bubble">{payload.message}</div>
          <div className="preview-sms__timestamp">{new Date().toLocaleTimeString()}</div>
        </div>
      </div>
      <div className="preview-sms__info">
        <span
          className={`preview-sms__count ${charCount > 160 ? 'preview-sms__count--warning' : ''}`}
        >
          {charCount} characters
        </span>
        {segmentCount > 1 && (
          <span className="preview-sms__segments">({segmentCount} SMS segments)</span>
        )}
      </div>
    </div>
  );
}

function WebhookPreview({ payload }: { payload: WebhookPayload }) {
  return (
    <div className="preview-webhook">
      <div className="preview-webhook__method">
        <span className="preview-webhook__badge">POST</span>
        <span className="preview-webhook__url">https://your-endpoint.com/webhook</span>
      </div>
      <div className="preview-webhook__headers">
        <div className="preview-webhook__header">
          <span className="preview-webhook__header-name">Content-Type:</span>
          <span className="preview-webhook__header-value">application/json</span>
        </div>
      </div>
      <div className="preview-webhook__body">
        <pre>
          <code>{JSON.stringify(payload, null, 2)}</code>
        </pre>
      </div>
    </div>
  );
}
