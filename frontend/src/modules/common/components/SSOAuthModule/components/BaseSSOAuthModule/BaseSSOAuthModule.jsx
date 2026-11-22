import React from 'react';
import { GoogleSSOLoginButton, GitSSOLoginButton } from '..';
import SSOButtonWrapper from '../SSOButtonWrapper';
import { isConfiguredOidcEnabled, startConfiguredOidc } from '../../configuredOidc';

const BaseSSOAuthModule = ({
  configs,
  organizationId,
  setRedirectUrlToCookie,
  buttonText,
  setSignupOrganizationDetails,
  gitSSORef,
  googleSSORef,
  redirectTo,
}) => {
  return (
    <>
      {isConfiguredOidcEnabled(organizationId) && (
        <div className="login-sso-wrapper">
          <SSOButtonWrapper
            onClick={(event) => {
              event.preventDefault();
              startConfiguredOidc(redirectTo);
            }}
            icon="assets/images/sso-buttons/openid.svg"
            text={`${buttonText} OpenID Connect`}
            dataCy="configured-oidc-sso-button"
          />
        </div>
      )}
      {configs?.git?.enabled && (
        <div className="login-sso-wrapper">
          <GitSSOLoginButton
            ref={gitSSORef}
            configs={configs?.git?.configs}
            setRedirectUrlToCookie={setRedirectUrlToCookie}
            setSignupOrganizationDetails={setSignupOrganizationDetails}
            buttonText={buttonText}
            redirectTo={redirectTo}
          />
        </div>
      )}
      {configs?.google?.enabled && (
        <div className="login-sso-wrapper">
          <GoogleSSOLoginButton
            ref={googleSSORef}
            configs={configs?.google?.configs}
            configId={configs?.google?.config_id}
            setRedirectUrlToCookie={setRedirectUrlToCookie}
            setSignupOrganizationDetails={setSignupOrganizationDetails}
            buttonText={buttonText}
            redirectTo={redirectTo}
          />
        </div>
      )}
    </>
  );
};

export default BaseSSOAuthModule;
