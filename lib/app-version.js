'use strict';

const axios = require('axios');
const crypto = require('crypto');

/**
 * Mercedes mobile-app identity for outgoing requests.
 *
 * Every Mercedes endpoint (OAuth, REST, WebSocket) is sent a set of headers
 * describing which build of the Mercedes me app is calling. The backend cares:
 * stale values have historically been answered with HTTP 418, and an account
 * that keeps presenting one can end up refused at the WebSocket upgrade with
 * HTTP 429 for hours at a time - a block no amount of backoff clears, because
 * it is not really about request volume.
 *
 * Hardcoding the version is therefore a slow leak: it works until Mercedes
 * ships an app update and starts rejecting the old one. mbapi2020 solved this
 * by asking Mercedes what it wants (`/v1/config`) and, when told the client is
 * out of date, resolving the current version from the App Store. This is a
 * port of that (app_version.py), keeping the same two-step contract:
 *
 *   1. `/v1/config` reports `forceUpdate.status`. Only FORCE / INFORM_ALWAYS
 *      mean "you are too old" - anything else leaves the version alone.
 *   2. `forceUpdate.storeUrl` points at the App Store listing, whose numeric
 *      id feeds the iTunes lookup API for the actual current version string.
 *
 * The defaults below are the fallback for when that lookup is unavailable, and
 * are kept in step with mbapi2020's const.py.
 */

// Defaults: what we send until (and unless) /v1/config tells us the build is
// too old to be accepted.
//
// DO NOT bump these to match mbapi2020 without re-testing the REST payload.
// mbapi2020 runs SDK 4.10.0 / app 1.68.0 (3060), and adopting that pair was
// measured to change what the widget endpoint returns: the same
// /v1/vehicle/{vin}/vehicleattributes request that answers 651 bytes of
// decodable VEPUpdate (vin at field 2, attributes at field 11) under the
// values below instead answered 365 bytes of a different message entirely -
// vin at field 1, payload at fields 108/109 - which VEPUpdate.decode rejects
// outright, taking every polled capability (battery, range, position) down
// with it. Mercedes evidently serves a newer response schema to clients
// declaring a newer build, and our parser has not been ported to it.
//
// Note the build numbers are not ordered the way the versions are: the 1.65.1
// below carries build 3174, mbapi2020's 1.68.0 carries 3060.
const RIS_OS_NAME = 'ios';
const RIS_OS_VERSION = '26.3';
const RIS_SDK_VERSION = '4.4.2';
const RIS_SDK_VERSION_CN = '2.132.2';
const RIS_APPLICATION_VERSION = '1.65.1 (3174)';
const RIS_APPLICATION_VERSION_NA = '3.67.0';
const RIS_APPLICATION_VERSION_CN = '1.67.0';
const RIS_APPLICATION_VERSION_PA = '1.67.0';

const USER_AGENT = 'Mercedes-Benz/3044 CFNetwork/3860.400.22 Darwin/25.3.0';
const USER_AGENT_CN = 'MyStarCN/1.63.0 (com.daimler.ris.mercedesme.cn.ios; build:1758; iOS 16.3.1) Alamofire/5.4.0';

// Re-check no more than once per 6 hours (mbapi2020 uses the same interval).
// The version only moves when Mercedes ships a release, so polling harder buys
// nothing and adds requests to an API that punishes chattiness.
const CHECK_INTERVAL_MS = 21600 * 1000;

// Only these two statuses mean the running version is no longer acceptable.
const UPDATE_REQUIRED_STATUSES = new Set(['FORCE', 'INFORM_ALWAYS']);

const APP_STORE_ID_PATTERN = /\/id(\d+)/;

const APP_STORE_COUNTRY_BY_REGION = {
  'Europe': 'de',
  'North America': 'us',
  'Asia-Pacific': 'au',
  'China': 'cn',
};

/**
 * Per-region request profile. Mercedes runs a different app (and a different
 * SDK line) per market, so the identity we present has to match the region the
 * account belongs to.
 */
function buildRegionProfile(region) {
  switch (region) {
    case 'North America':
      return {
        applicationName: 'mycar-store-us',
        defaultVersion: RIS_APPLICATION_VERSION_NA,
        sdkVersion: RIS_SDK_VERSION,
        oauthUserAgent: USER_AGENT,
        webapiUserAgent: USER_AGENT,
        websocketUserAgentTemplate: (v) => `mycar-store-us v${v}, ${RIS_OS_NAME} ${RIS_OS_VERSION}, SDK ${RIS_SDK_VERSION}`,
      };

    case 'Asia-Pacific':
      return {
        applicationName: 'mycar-store-ap',
        defaultVersion: RIS_APPLICATION_VERSION_PA,
        sdkVersion: RIS_SDK_VERSION,
        oauthUserAgent: `mycar-store-ap ${RIS_APPLICATION_VERSION_PA}, ${RIS_OS_NAME} ${RIS_OS_VERSION}, SDK ${RIS_SDK_VERSION}`,
        webapiUserAgent: USER_AGENT,
        websocketUserAgentTemplate: (v) => `mycar-store-ap ${v}, ${RIS_OS_NAME} ${RIS_OS_VERSION}, SDK ${RIS_SDK_VERSION}`,
      };

    case 'China':
      return {
        applicationName: 'mycar-store-cn',
        defaultVersion: RIS_APPLICATION_VERSION_CN,
        sdkVersion: RIS_SDK_VERSION_CN,
        oauthUserAgent: USER_AGENT_CN,
        webapiUserAgent: USER_AGENT_CN,
        websocketUserAgentStatic: USER_AGENT_CN,
      };

    default:
      return {
        applicationName: 'mycar-store-ece',
        defaultVersion: RIS_APPLICATION_VERSION,
        sdkVersion: RIS_SDK_VERSION,
        oauthUserAgent: USER_AGENT,
        webapiUserAgent: USER_AGENT,
        websocketUserAgentStatic: USER_AGENT,
      };
  }
}

class AppVersionManager {
  constructor(homey, region) {
    this.homey = homey;
    this.region = region;
    this.profile = buildRegionProfile(region);

    this.applicationVersion = this.profile.defaultVersion;
    this._lastCheckAt = 0;

    // Serializes refreshes. Three callers (OAuth, REST, WebSocket) can each ask
    // to refresh on the same startup; without this they would all fire the
    // config + App Store round trip at once.
    this._refreshPromise = null;

    this._client = axios.create({ timeout: 15000 });
  }

  get applicationName() {
    return this.profile.applicationName;
  }

  get sdkVersion() {
    return this.profile.sdkVersion;
  }

  oauthUserAgent() {
    if (this.region === 'Asia-Pacific') {
      return `mycar-store-ap ${this.applicationVersion}, ${RIS_OS_NAME} ${RIS_OS_VERSION}, SDK ${RIS_SDK_VERSION}`;
    }
    return this.profile.oauthUserAgent;
  }

  webapiUserAgent() {
    return this.profile.webapiUserAgent;
  }

  websocketUserAgent() {
    if (this.profile.websocketUserAgentTemplate) {
      return this.profile.websocketUserAgentTemplate(this.applicationVersion);
    }
    return this.profile.websocketUserAgentStatic || this.profile.webapiUserAgent;
  }

  /**
   * Refresh the application version if the check interval has elapsed.
   *
   * Never throws and never blocks the caller's real work: a failed lookup just
   * leaves the current version in place. Losing the ability to *upgrade* the
   * version we claim is a slow problem; failing a login or a WebSocket connect
   * because the App Store was unreachable would be an immediate one.
   *
   * @returns {Promise<boolean>} true if the version actually changed
   */
  async refresh(restBase, { force = false } = {}) {
    // No endpoint, nothing to ask. Callers reach this from the hot path of
    // every request, so an unusable base must be a quiet no-op rather than a
    // thrown error that takes the request down with it.
    if (typeof restBase !== 'string' || !restBase.startsWith('http')) {
      return false;
    }

    if (!force && Date.now() - this._lastCheckAt < CHECK_INTERVAL_MS) {
      return false;
    }

    if (this._refreshPromise) {
      return this._refreshPromise;
    }

    this._refreshPromise = this._refreshInternal(restBase)
      .catch((error) => {
        this.homey.app.log(`[AppVersion] Refresh failed (keeping ${this.applicationVersion}): ${error.message}`);
        return false;
      })
      .finally(() => {
        this._refreshPromise = null;
      });

    return this._refreshPromise;
  }

  async _refreshInternal(restBase) {
    // Mark the attempt before doing the work, so a backend that is down cannot
    // turn every request into a retry storm against it.
    this._lastCheckAt = Date.now();

    const config = await this._fetchRemoteConfig(restBase);
    if (!config || typeof config !== 'object') return false;

    const forceUpdate = config.forceUpdate;
    if (!forceUpdate || typeof forceUpdate !== 'object') return false;

    if (!UPDATE_REQUIRED_STATUSES.has(forceUpdate.status)) {
      return false;
    }

    this.homey.app.log(`[AppVersion] Mercedes reports status ${forceUpdate.status} for our app version ${this.applicationVersion}`);

    const newVersion = await this._lookupAppStoreVersion(forceUpdate.storeUrl);
    if (!newVersion) {
      this.homey.app.log(`[AppVersion] Mercedes wants a newer app version but none could be resolved from the App Store`);
      return false;
    }

    if (newVersion === this.applicationVersion) return false;

    this.homey.app.log(`[AppVersion] Updating app version ${this.applicationVersion} -> ${newVersion}`);
    this.applicationVersion = newVersion;
    return true;
  }

  async _fetchRemoteConfig(restBase) {
    const headers = {
      'Ris-Os-Name': RIS_OS_NAME,
      'Ris-Os-Version': RIS_OS_VERSION,
      'Ris-Sdk-Version': this.sdkVersion,
      'Ris-Application-Version': this.applicationVersion,
      'X-Applicationname': this.applicationName,
      'X-Locale': 'en-GB',
      'X-Trackingid': crypto.randomUUID(),
      'X-Sessionid': crypto.randomUUID(),
      'User-Agent': this.oauthUserAgent(),
      'Content-Type': 'application/json',
    };

    const response = await this._client.get(`${restBase}/v1/config`, {
      headers,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      this.homey.app.log(`[AppVersion] Config endpoint returned HTTP ${response.status}`);
      return null;
    }

    return response.data;
  }

  async _lookupAppStoreVersion(storeUrl) {
    if (typeof storeUrl !== 'string') return null;

    const match = APP_STORE_ID_PATTERN.exec(storeUrl);
    if (!match) {
      this.homey.app.log(`[AppVersion] Could not extract an App Store id from ${storeUrl}`);
      return null;
    }

    const params = { id: match[1] };
    const country = APP_STORE_COUNTRY_BY_REGION[this.region];
    if (country) params.country = country;

    const response = await this._client.get('https://itunes.apple.com/lookup', {
      params,
      validateStatus: () => true,
    });

    if (response.status >= 400) {
      this.homey.app.log(`[AppVersion] App Store lookup returned HTTP ${response.status}`);
      return null;
    }

    const results = response.data && response.data.results;
    if (!Array.isArray(results) || results.length === 0) return null;

    const version = results[0].version;
    return typeof version === 'string' ? version : null;
  }

  /** Headers for OAuth / config calls. */
  applyOAuthHeaders(headers) {
    headers['X-Applicationname'] = this.applicationName;
    headers['Ris-Application-Version'] = this.applicationVersion;
    headers['Ris-Sdk-Version'] = this.sdkVersion;
    headers['User-Agent'] = this.oauthUserAgent();
    return headers;
  }

  /** Headers for REST API calls. */
  applyWebApiHeaders(headers) {
    headers['X-ApplicationName'] = this.applicationName;
    headers['ris-application-version'] = this.applicationVersion;
    headers['ris-sdk-version'] = this.sdkVersion;
    headers['ris-os-name'] = RIS_OS_NAME;
    headers['ris-os-version'] = RIS_OS_VERSION;
    headers['User-Agent'] = this.webapiUserAgent();
    return headers;
  }

  /** Headers for the WebSocket upgrade. */
  applyWebSocketHeaders(headers) {
    headers['X-ApplicationName'] = this.applicationName;
    headers['ris-application-version'] = this.applicationVersion;
    headers['ris-sdk-version'] = this.sdkVersion;
    headers['ris-os-name'] = RIS_OS_NAME;
    headers['ris-os-version'] = RIS_OS_VERSION;
    headers['User-Agent'] = this.websocketUserAgent();

    if (this.region === 'North America') {
      headers['X-Locale'] = 'en-US';
      headers['Accept-Encoding'] = 'gzip';
      headers['Sec-WebSocket-Extensions'] = 'permessage-deflate';
    }

    return headers;
  }
}

module.exports = {
  AppVersionManager,
  RIS_OS_NAME,
  RIS_OS_VERSION,
  RIS_SDK_VERSION,
  RIS_APPLICATION_VERSION,
  USER_AGENT,
};
