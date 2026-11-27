import React, { useState } from 'react';
import { toast } from 'react-hot-toast';
import { organizationService } from '@/_services';
import { ButtonSolid } from '@/_ui/AppButton/AppButton';

export default function ManagedOidcSettings({ registration, onSaved }) {
  const [enabled, setEnabled] = useState(registration.enabled);
  const [saving, setSaving] = useState(false);
  const unchanged = enabled === registration.enabled && (!registration.using_deployment_default || !enabled);

  const save = async (mode) => {
    setSaving(true);
    try {
      const result = await organizationService.setManagedOidc(registration.workspace_id, mode);
      onSaved(result);
      toast.success('OpenID Connect settings saved');
    } catch {
      toast.error('Could not save OpenID Connect settings');
    } finally {
      setSaving(false);
    }
  };

  return (
    <fieldset className="tw-mt-4 tw-rounded-md tw-border tw-border-solid tw-p-4">
      <legend className="tw-w-auto tw-px-1 tw-font-title-default">OpenID Connect</legend>
      <dl className="tw-mb-4 tw-grid tw-gap-2 tw-break-all">
        <div>
          <dt>Issuer</dt>
          <dd className="tw-mb-0">{registration.issuer}</dd>
        </div>
        <div>
          <dt>Client ID</dt>
          <dd className="tw-mb-0">{registration.client_id}</dd>
        </div>
        <div>
          <dt>Callback URL</dt>
          <dd className="tw-mb-0">{registration.redirect_uri}</dd>
        </div>
      </dl>
      <label className="tw-flex tw-items-center tw-gap-2">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving || !registration.can_edit}
          onChange={(event) => setEnabled(event.target.checked)}
        />
        Enable workspace sign-in
      </label>
      <p className="tw-my-2 tw-font-body-default">
        Turning this off stops sign-in and connected REST queries for this workspace.
      </p>
      <div className="tw-flex tw-flex-wrap tw-gap-2">
        <ButtonSolid
          variant="primary"
          disabled={saving || !registration.can_edit || unchanged}
          isLoading={saving}
          onClick={() => save(enabled ? 'enabled' : 'disabled')}
        >
          Save OpenID Connect
        </ButtonSolid>
        {!registration.using_deployment_default && (
          <ButtonSolid
            variant="tertiary"
            disabled={saving || !registration.can_edit}
            onClick={() => save('deployment_default')}
          >
            Restore deployment default
          </ButtonSolid>
        )}
      </div>
    </fieldset>
  );
}
