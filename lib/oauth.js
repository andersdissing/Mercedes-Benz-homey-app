'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { CookieJar } = require('tough-cookie');
const { wrapper } = require('axios-cookiejar-support');
const { URL, URLSearchParams } = require('url');

/**
 * Mercedes-Benz OAuth2 Authentication Client
 * Based on mbapi2020 OAuth implementation with PKCE flow
 * Matches the HA integration oauth.py implementation exactly
 */
class MercedesOAuth {
  // OAuth2 Configuration
  static CLIENT_ID = '62778dc4-1de3-44f4-af95-115f06a3a008';
  static REDIRECT_URI = 'rismycar://login-callback';
  static SCOPE = 'email profile ciam-uid phone openid offline_access';

  // Region-specific endpoints
  static ENDPOINTS = {
    'Europe': {
      login: 'https://id.mercedes-benz.com',
      rest: 'https://bff.emea-prod.mobilesdk.mercedes-benz.com',
      websocket: 'wss://websocket.emea-prod.mobilesdk.mercedes-benz.com/v2/ws'
    },
    'North America': {
      login: 'https://id.mercedes-benz.com',
      rest: 'https://bff.amap-prod.mobilesdk.mercedes-benz.com',
      websocket: 'wss://websocket.amap-prod.mobilesdk.mercedes-benz.com/v2/ws'
    },
    'Asia-Pacific': {
      login: 'https://id.mercedes-benz.com',
      rest: 'https://bff.amap-prod.mobilesdk.mercedes-benz.com',
      websocket: 'wss://websocket.amap-prod.mobilesdk.mercedes-benz.com/v2/ws'
    },
    'China': {
      login: 'https://ciam-1.mercedes-benz.com.cn',
      rest: 'https://bff.cn-prod.mobilesdk.mercedes-benz.com',
      websocket: 'wss://websocket.cn-prod.mobilesdk.mercedes-benz.com/v2/ws'
    }
  };

  constructor(homey, region = 'Europe', deviceGuid = null) {
    this.homey = homey;
    this.region = region;
    this.endpoints = MercedesOAuth.ENDPOINTS[region];

    if (!this.endpoints) {
      throw new Error(`Invalid region: ${region}`);
    }

    this.token = null;
    this.codeVerifier = null;
    this.codeChallenge = null;

    // Use provided deviceGuid or generate new one
    this.deviceGuid = deviceGuid || this._generateDeviceGuid();

    // Create cookie jar and set CIAM.DEVICE cookie (critical!)
    const jar = new CookieJar();

    // Set the CIAM.DEVICE cookie for all requests to login domain
    const Cookie = require('tough-cookie').Cookie;
    const ciamCookie = Cookie.parse(`CIAM.DEVICE=${this.deviceGuid}; Domain=.mercedes-benz.com; Path=/`);
    jar.setCookieSync(ciamCookie, this.endpoints.login);

    // Create axios instance with cookie support
    this.client = wrapper(axios.create({
      timeout: 30000,
      jar: jar,
      withCredentials: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1',
        'Accept-Language': 'de-DE,de;q=0.9'
      }
    }));

    this.homey.app.log(`OAuth initialized for region: ${region}, deviceGuid: ${this.deviceGuid}`);
  }

  /**
   * Generate PKCE parameters for OAuth2 flow (matches HA implementation)
   */
  _generatePKCE() {
    // Generate code_verifier (matches HA: base64.urlsafe_b64encode(secrets.token_bytes(32)))
    const codeVerifier = crypto.randomBytes(32)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    // Generate code_challenge (SHA256 hash of code_verifier, base64url encoded)
    const codeChallenge = crypto.createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    this.codeVerifier = codeVerifier;
    this.codeChallenge = codeChallenge;

    this.homey.app.log('Generated PKCE parameters for OAuth2 flow');
  }

  /**
   * Generate device GUID (should be persistent across sessions)
   */
  _generateDeviceGuid() {
    return crypto.randomUUID();
  }

  /**
   * Get mobile Safari headers (matches HA _get_mobile_safari_headers)
   */
  _getMobileSafariHeaders(accept = 'application/json, text/plain, */*', includeReferer = true) {
    const headers = {
      'accept': accept,
      'content-type': 'application/json',
      'origin': this.endpoints.login,
      'accept-language': 'de-DE,de;q=0.9',
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1'
    };

    if (includeReferer) {
      headers['referer'] = `${this.endpoints.login}/ciam/auth/login`;
    }

    return headers;
  }

  /**
   * Extract authorization code from redirect URL
   */
  _extractCodeFromRedirectUrl(redirectUrl) {
    try {
      const url = new URL(redirectUrl);
      const code = url.searchParams.get('code');

      if (!code) {
        throw new Error('Authorization code not found in redirect URL');
      }

      return code;
    } catch (error) {
      this.homey.app.error('Failed to extract code from URL:', redirectUrl, error.message);
      throw new Error('Authorization code not found in redirect URL');
    }
  }

  /**
   * Step 1: Get authorization URL and extract resume parameter
   * Matches HA: async def _get_authorization_resume(self)
   */
  async _getAuthorizationResume() {
    this._generatePKCE();

    const params = new URLSearchParams({
      client_id: MercedesOAuth.CLIENT_ID,
      code_challenge: this.codeChallenge,
      code_challenge_method: 'S256',
      redirect_uri: MercedesOAuth.REDIRECT_URI,
      response_type: 'code',
      scope: MercedesOAuth.SCOPE
    });

    const headers = {
      'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_8_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6.6 Mobile/15E148 Safari/604.1',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'de-DE,de;q=0.9'
    };

    const authUrl = `${this.endpoints.login}/as/authorization.oauth2?${params.toString()}`;

    try {
      const response = await this.client.get(authUrl, {
        headers,
        maxRedirects: 5
      });

      // Extract resume parameter from the final URL
      const finalUrl = new URL(response.request.res.responseUrl);
      const resume = finalUrl.searchParams.get('resume');

      if (!resume) {
        throw new Error('Resume parameter not found in authorization response');
      }

      this.homey.app.log('Authorization resume parameter obtained');
      return resume;

    } catch (error) {
      this.homey.app.error('Authorization request failed:', error.message);
      throw new Error(`Authorization request failed: ${error.message}`);
    }
  }

  /**
   * Step 2: Send user agent information
   * Matches HA: async def _send_user_agent_info(self)
   */
  async _sendUserAgentInfo() {
    const headers = this._getMobileSafariHeaders('*/*', false);

    const data = {
      browserName: 'Mobile Safari',
      browserVersion: '15.6.6',
      osName: 'iOS'
    };

    const url = `${this.endpoints.login}/ciam/auth/ua`;

    try {
      await this.client.post(url, data, { headers });
      this.homey.app.log('User agent info sent');
    } catch (error) {
      // This can fail without breaking the flow
      this.homey.app.error('User agent info submission failed (non-critical):', error.message);
    }
  }

  /**
   * Step 3: Submit username
   * Matches HA: async def _submit_username(self, email: str)
   */
  async _submitUsername(email) {
    const headers = this._getMobileSafariHeaders();
    const url = `${this.endpoints.login}/ciam/auth/login/user`;

    try {
      const response = await this.client.post(url, { username: email }, { headers });
      this.homey.app.log('Username submitted successfully');
      return response.data;
    } catch (error) {
      this.homey.app.error('Username submission error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw new Error(`Username submission failed: ${error.message}`);
    }
  }

  /**
   * Step 4: Submit password and get pre-login token
   * Matches HA: async def _submit_password(self, email: str, password: str)
   */
  async _submitPassword(email, password) {
    // Generate random ID (matches HA: rid = secrets.token_urlsafe(24))
    const rid = crypto.randomBytes(24).toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=/g, '');

    const headers = this._getMobileSafariHeaders();

    const data = {
      username: email,
      password: password,
      rememberMe: false,
      rid: rid
    };

    const url = `${this.endpoints.login}/ciam/auth/login/pass`;

    try {
      const response = await this.client.post(url, data, { headers });
      this.homey.app.log('Password submitted successfully');
      return response.data;
    } catch (error) {
      this.homey.app.error('Password submission error:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data
      });
      throw new Error(`Password submission failed: ${error.message}`);
    }
  }

  /**
   * Step 4b: Submit legal consent (if required)
   * Matches HA: async def _submit_legal_consent(self, home_country: str, consent_country: str)
   */
  async _submitLegalConsent(homeCountry, consentCountry) {
    const headers = this._getMobileSafariHeaders();

    const data = {
      texts: {},
      homeCountry: homeCountry,
      consentCountry: consentCountry
    };

    const url = `${this.endpoints.login}/ciam/auth/toas/saveLoginConsent`;

    try {
      const response = await this.client.post(url, data, { headers });
      this.homey.app.log('Legal consent submitted');
      return response.data;
    } catch (error) {
      this.homey.app.error('Legal consent error:', error.message);
      throw new Error(`Legal consent submission failed: ${error.message}`);
    }
  }

  /**
   * Step 5: Resume authorization and get code
   * Matches HA: async def _resume_authorization(self, resume_url: str, token: str)
   */
  async _resumeAuthorization(resumeUrl, token) {
    const headers = this._getMobileSafariHeaders('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
    headers['content-type'] = 'application/x-www-form-urlencoded';

    const data = new URLSearchParams({ token: token }).toString();
    const url = `${this.endpoints.login}${resumeUrl}`;

    try {
      const response = await this.client.post(url, data, {
        headers,
        maxRedirects: 0,
        validateStatus: (status) => status === 302 || status === 301 || status < 400
      });

      // Check for redirect with code
      const location = response.headers['location'];

      if (location && location.startsWith('rismycar://')) {
        const code = this._extractCodeFromRedirectUrl(location);
        this.homey.app.log('Authorization code obtained');
        return code;
      }

      throw new Error('No redirect to rismycar:// found');

    } catch (error) {
      // Handle axios InvalidURL error for custom scheme
      if (error.message && error.message.includes('rismycar://')) {
        // Extract URL from error message
        const match = error.message.match(/rismycar:\/\/[^\s'"]+/);
        if (match) {
          const code = this._extractCodeFromRedirectUrl(match[0]);
          this.homey.app.log('Authorization code obtained from error redirect');
          return code;
        }
      }

      this.homey.app.error('Resume authorization error:', error.message);
      throw new Error(`Authorization resume failed: ${error.message}`);
    }
  }

  /**
   * Step 6: Exchange authorization code for tokens
   * Matches HA: async def _exchange_code_for_tokens(self, code: str)
   */
  async _exchangeCodeForTokens(code) {
    if (!this.codeVerifier) {
      throw new Error('Code verifier not available for token exchange');
    }

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded'
    };

    const data = new URLSearchParams({
      client_id: MercedesOAuth.CLIENT_ID,
      code: code,
      code_verifier: this.codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: MercedesOAuth.REDIRECT_URI
    }).toString();

    const url = `${this.endpoints.login}/as/token.oauth2`;

    try {
      const response = await this.client.post(url, data, { headers });

      // Add expiration timestamp
      const tokenInfo = response.data;
      tokenInfo.expires_at = Math.floor(Date.now() / 1000) + tokenInfo.expires_in;

      this.homey.app.log('Token exchange successful');
      return tokenInfo;

    } catch (error) {
      this.homey.app.error('Token exchange error:', {
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Token exchange failed: ${error.message}`);
    }
  }

  /**
   * Main login method - performs complete OAuth2 PKCE flow
   * Matches HA: async def async_login_new(self, email: str, password: str)
   */
  async login(email, password) {
    this.homey.app.log(`Starting OAuth2 login flow for: ${email}`);

    try {
      // Step 1: Get authorization resume parameter
      const resumeUrl = await this._getAuthorizationResume();

      // Step 2: Send user agent info
      await this._sendUserAgentInfo();

      // Step 3: Submit username
      await this._submitUsername(email);

      // Step 4: Submit password and get pre-login data
      let preLoginData = await this._submitPassword(email, password);

      // Check result and handle special cases
      if (preLoginData.result !== 'RESUME2OIDCP') {
        if (preLoginData.result === 'GOTO_LOGIN_OTP') {
          throw new Error('Two-factor authentication (2FA) is not supported. Please disable 2FA on your Mercedes Me account.');
        }

        if (preLoginData.result === 'GOTO_LOGIN_LEGAL_TEXTS') {
          this.homey.app.log('Legal consent required');
          const homeCountry = preLoginData.homeCountry || '';
          const consentCountry = preLoginData.consentCountry || '';
          preLoginData = await this._submitLegalConsent(homeCountry, consentCountry);

          if (preLoginData.result !== 'RESUME2OIDCP') {
            throw new Error('Problem accepting legal terms during login');
          }
        } else {
          throw new Error(`Unexpected login result: ${preLoginData.result}`);
        }
      }

      // Step 5: Resume authorization and get code
      const authCode = await this._resumeAuthorization(resumeUrl, preLoginData.token);

      // Step 6: Exchange code for tokens
      const tokenInfo = await this._exchangeCodeForTokens(authCode);

      // Save token
      this.token = tokenInfo;

      // Clear PKCE parameters
      this.codeVerifier = null;
      this.codeChallenge = null;

      this.homey.app.log('OAuth2 login successful');
      return tokenInfo;

    } catch (error) {
      this.homey.app.error('OAuth2 login failed:', error.message);
      throw error;
    }
  }

  /**
   * Refresh access token using refresh token
   * Matches HA: async def async_refresh_access_token(self, refresh_token: str)
   */
  async refreshAccessToken(refreshToken) {
    this.homey.app.log('Refreshing access token');

    const headers = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Device-Id': this.deviceGuid,
      'X-Request-Id': crypto.randomUUID()
    };

    const data = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken
    }).toString();

    const url = `${this.endpoints.login}/as/token.oauth2`;

    try {
      const response = await this.client.post(url, data, { headers });

      const tokenInfo = response.data;

      // If refresh_token not in response, use the old one
      if (!tokenInfo.refresh_token) {
        tokenInfo.refresh_token = refreshToken;
      }

      // Add expiration timestamp
      tokenInfo.expires_at = Math.floor(Date.now() / 1000) + tokenInfo.expires_in;

      this.token = tokenInfo;
      this.homey.app.log('Token refresh successful');

      return tokenInfo;

    } catch (error) {
      this.homey.app.error('Token refresh error:', {
        status: error.response?.status,
        data: error.response?.data
      });
      throw new Error(`Token refresh failed: ${error.message}`);
    }
  }

  /**
   * Get access token (with automatic refresh if expired)
   */
  async getAccessToken() {
    if (!this.token) {
      throw new Error('Not authenticated. Please login first.');
    }

    // Check if token is expired
    if (MercedesOAuth.isTokenExpired(this.token)) {
      this.homey.app.log('Access token expired, refreshing...');
      await this.refreshToken();
    }

    return this.token.access_token;
  }

  /**
   * Check if token is expired (with 60 second buffer)
   * Matches HA: def is_token_expired(cls, token_info)
   */
  static isTokenExpired(tokenInfo) {
    if (!tokenInfo || !tokenInfo.expires_at) {
      return true;
    }

    const now = Math.floor(Date.now() / 1000);
    return tokenInfo.expires_at - now < 60; // 60 second buffer
  }

  /**
   * Get vehicles list
   * Matches HA: webapi.py get_user_info() method
   */
  async getVehicles() {
    if (!this.token || !this.token.access_token) {
      throw new Error('Not authenticated. Please login first.');
    }

    // Match HA headers exactly (from webapi.py _request method)
    const headers = {
      'Authorization': `Bearer ${this.token.access_token}`,
      'X-SessionId': crypto.randomUUID().toUpperCase(),
      'X-TrackingId': crypto.randomUUID().toUpperCase(),
      'X-ApplicationName': 'mycar-store-ece',
      'ris-application-version': '1.61.0',
      'ris-os-name': 'android',
      'ris-os-version': '12',
      'ris-sdk-version': '3.55.0',
      'X-Locale': 'de-DE',
      'User-Agent': 'MyCar/2168 CFNetwork/1494.0.7 Darwin/23.4.0',
      'Content-Type': 'application/json; charset=UTF-8'
    };

    const url = `${this.endpoints.rest}/v2/vehicles`;

    try {
      const response = await this.client.get(url, { headers });

      // Match HA implementation: __init__.py line 109
      // Response structure: { assignedVehicles: [...], ... }
      const masterdata = response.data || {};
      const vehicles = masterdata.assignedVehicles || [];

      this.homey.app.log(`Found ${vehicles.length} vehicle(s)`);
      return vehicles;

    } catch (error) {
      this.homey.app.error('Failed to fetch vehicles:', error.message);
      throw new Error(`Failed to retrieve vehicles: ${error.message}`);
    }
  }
}

module.exports = MercedesOAuth;
