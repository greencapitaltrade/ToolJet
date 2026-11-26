import { captureMcpOAuthBootstrap } from './McpOAuth/bootstrap';
import { captureSignerHandoff, getSignerHandoff, clearSignerHandoff } from './SignerHandoff/bootstrap';
import { captureParticipantHandoff, getParticipantHandoff, clearParticipantHandoff } from './ParticipantHandoff/bootstrap';
import { captureReferralHandoff, getReferralHandoff, clearReferralHandoff } from './ReferralHandoff/bootstrap';

captureMcpOAuthBootstrap();
captureSignerHandoff();
captureParticipantHandoff();
captureReferralHandoff();
window.getToolJetSignerHandoff = () => getSignerHandoff();
window.clearToolJetSignerHandoff = (token) => clearSignerHandoff(token);
window.getToolJetParticipantHandoff = () => getParticipantHandoff();
window.clearToolJetParticipantHandoff = (token) => clearParticipantHandoff(token);
window.getToolJetReferralHandoff = () => getReferralHandoff();
window.clearToolJetReferralHandoff = (token) => clearReferralHandoff(token);
