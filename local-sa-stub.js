/* ──────────────────────────────────────────────────────────────────────────
 * local-sa-stub.js — a stand-in for the SuperAnnotate host globals, so
 * superannotate-mask-editor.js can boot outside the platform.
 *
 * Load this as a CLASSIC script BEFORE the module. The bundle throws at import
 * time if these are missing:
 *     line  75   !("SA" in window) || !("SALIB" in window)
 *     line 147   !("SA" in window)
 *     line 188   !("SA" in window)
 *     line 232   !("SA_SDK" in window)
 *
 * Everything below was read off the bundle rather than guessed:
 *   • SA needs      getValue, updateValue, dispatchEvent, onMessage,
 *                   setContext, setKeySchema, showPushNotification
 *   • SA_SDK needs  17 methods (see SDK_METHODS), of which the boot path uses
 *                   currentTeam, currentUser, currentProject, currentAsset,
 *                   workflowRoles, workflowStatuses, getClasses
 *   • shapes are pinned by the consumers in SaSdkBase.init():
 *       workflowRoles()    -> [{ id, name }]        matched against project.my_role
 *       workflowStatuses() -> [{ status_id, status: { name } }]
 *                             matched against asset.data.annotation_status
 *       ItemData default   -> { images: [] }
 *       ConfigData default -> { classes: [] }
 *
 * Anything NOT covered falls through a Proxy that resolves to null and logs
 * the call, so an unexpected method degrades visibly instead of throwing.
 * Edit LOCAL_FIXTURE below to point at your own image/classes.
 * ────────────────────────────────────────────────────────────────────────── */
(function () {
  "use strict";

  // A self-contained sample image, so nothing needs the network.
  var SAMPLE_IMAGE =
    "data:image/svg+xml;utf8," +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600">' +
        '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0" stop-color="#2a4a7f"/><stop offset="1" stop-color="#7f2a5a"/>' +
        "</linearGradient></defs>" +
        '<rect width="900" height="600" fill="url(#g)"/>' +
        '<circle cx="300" cy="240" r="130" fill="#e8c46a"/>' +
        '<rect x="520" y="300" width="260" height="190" fill="#4ade80"/>' +
        '<polygon points="120,560 300,400 470,560" fill="#ff6b6b"/>' +
        '<text x="30" y="50" font-family="monospace" font-size="26" fill="#fff">' +
        "local test image 900x600</text>" +
        "</svg>"
    );

  var LOCAL_FIXTURE = {
    team: { id: 1, name: "Local Team" },
    user: { id: 1, email: "local@example.com", first_name: "Local", last_name: "User" },
    // my_role becomes currentUserRoleId, which every role gate is evaluated
    // against. ADMIN_ROLE_ID is 3, and a real config grants things like
    // uploadFileRoles/downloadAnnotationRoles to [3], so the harness user is
    // an admin by default — otherwise those features are simply hidden.
    // workflow_id is required by getStatusChangeRules(), which throws without it.
    project: { id: 1, name: "Local Project", my_role: 3, type: "Vector", workflow_id: 7 },
    // asset.data.annotation_status must match a workflowStatuses() status_id,
    // and asset.data.id is the signer id SaSdkBase.signUrls() requires.
    asset: {
      id: 1,
      name: "sample.png",
      url: SAMPLE_IMAGE,
      data: { id: 1, annotation_status: 1 }
    },
    // id 3 is ADMIN_ROLE_ID; keep it present so my_role resolves to a name.
    roles: [
      { id: 1, name: "Annotator" },
      { id: 2, name: "QA" },
      { id: 3, name: "Admin" }
    ],
    // Two consumers read this with different shapes, so entries must carry
    // BOTH: the wrapper's workflowStatuses() maps {id, status.name,
    // status.description, status.key}, while getItemStatuses() and
    // getCurrentItemStatus() read {status_id, status.name}.
    statuses: [
      { id: 11, status_id: 1, status: { id: 1, name: "InProgress", description: "Being annotated", key: "in_progress" } },
      { id: 12, status_id: 2, status: { id: 2, name: "Completed",  description: "Finished",        key: "completed" } }
    ],
    categories: [
      { id: 1, project_id: 1, name: "Urban",  created_at: "", updated_at: "", deleted_at: null },
      { id: 2, project_id: 1, name: "Rural",  created_at: "", updated_at: "", deleted_at: null }
    ],
    proxies: [{ id: 1, name: "local-proxy" }],
    // getStatusChangeRules() reads .data.raw_config off the workflow response
    workflowRawConfig: { transitions: [], statuses: ["in_progress", "completed"] },
    // isValidClass() requires id/name/color/type to all be STRINGS — a numeric
    // id makes the whole config INVALID and the ConfigData constructor throws
    // "Context data is invalid". type must be one of SUPPORTED_CLASS_TYPES:
    // bbox, obbox, polygon, polyline, mask, keypoint, cuboid.
    // Ids follow the platform's own "class-<timestamp>-<rand>" format.
    classes: [
      { id: "class-1789590769448-mbbm0rg", name: "Class 1",  color: "#4271FF", type: "mask" },
      { id: "class-1789590769449-road001", name: "Road",     color: "#00CD6C", type: "mask" },
      { id: "class-1789590769450-sign002", name: "Sign",     color: "#F5222D", type: "polygon" },
      { id: "class-1789590769451-pole003", name: "Pole",     color: "#fbbf24", type: "bbox" }
    ],
    // Mirrors a real SA_CONTEXT: role selections are "all" | "none" | an array
    // of positive integer role ids (-1 also means none).
    configExtras: {
      uploadFileRoles: [3],
      downloadAnnotationRoles: [3]
    },
    // ItemData ({images: []}) and ConfigData ({classes: []}) both read through
    // SA.getValue(); returning both keys satisfies either validator.
    images: [{ name: "sample.png", url: SAMPLE_IMAGE, status: "InProgress", instances: [] }],
    // Permissive by default so nothing is hidden behind a role check.
    permissions: {
      canEdit: true, canSave: true, canDelete: true, canComment: true,
      canChangeStatus: true, canUpload: true, readOnly: false
    }
  };
  window.LOCAL_FIXTURE = LOCAL_FIXTURE;

  function log(kind, name, args) {
    if (!window.SA_STUB_VERBOSE && kind === "call") return;
    console.log("%c[sa-stub]%c " + kind + " " + name, "color:#7c5cff", "", args || "");
  }

  /** Any method not explicitly implemented resolves to null and is logged. */
  function forgiving(name, impl) {
    return new Proxy(impl, {
      get: function (target, prop) {
        if (prop in target) return target[prop];
        if (typeof prop !== "string") return undefined;
        return function () {
          log("UNSTUBBED", name + "." + prop, Array.prototype.slice.call(arguments));
          return Promise.resolve(null);
        };
      }
    });
  }

  var F = LOCAL_FIXTURE;

  /* Two SEPARATE stores — conflating them is why classes never appear:
   *   ConfigData (classes) <- window.SA_CONTEXT[CONFIG_DATA_KEY]
   *   ItemData   (images)  <- SA.getValue()
   *
   * SA_CONTEXT must exist BEFORE the module is evaluated: ConfigData's
   * constructor runs at module scope and does
   *     isJSONSerializable(window.SA_CONTEXT) ? window.SA_CONTEXT[key] : null
   * and JSON.stringify(undefined) does not throw, so the guard passes and an
   * absent SA_CONTEXT fails with
   *     can't access property "image-annotation-tool-config", t is undefined
   */
  var CONFIG_DATA_KEY = "image-annotation-tool-config";
  var configData = Object.assign({ classes: F.classes }, F.configExtras || {});
  window.SA_CONTEXT = window.SA_CONTEXT || {};
  window.SA_CONTEXT[CONFIG_DATA_KEY] = configData;
  // The base class defaults to "saConfigData" when constructed without a key.
  window.SA_CONTEXT.saConfigData = window.SA_CONTEXT.saConfigData || configData;

  var store = JSON.parse(JSON.stringify({ images: F.images }));

  // ── window.SA ───────────────────────────────────────────────────────────
  // All 30 methods of the real surface, matching their observed contracts:
  //   n.action(...).then(({data}) => data)   -> async, resolves to `data`
  //   n.post({...})                          -> fire and forget
  //   on/off                                 -> THROW on an unknown event name
  //   onMessage/onPyRequest                  -> return an unsubscribe function
  var messageHandlers = [];
  var pyRequestHandlers = [];
  var setValueCb = null;
  var listeners = {};          // channel -> [fn]

  // `on`/`off` look the name up in a registry and throw when it is absent.
  // Only the two modal channels are visible in the real surface; add your own
  // via window.LOCAL_FIXTURE.saEvents if your code subscribes to more.
  var SA_EVENTS = Object.assign(
    { modalOpened: "listenModalOpened", modalClosed: "listenModalClosed" },
    LOCAL_FIXTURE.saEvents || {}
  );

  function addListener(channel, fn) {
    (listeners[channel] = listeners[channel] || []).push(fn);
    return function () { removeListener(channel, fn); };
  }
  function removeListener(channel, fn) {
    var a = listeners[channel];
    if (!a) return;
    var i = a.indexOf(fn);
    if (i >= 0) a.splice(i, 1);
  }

  window.SA = forgiving("SA", {
    // ---- value / context ----
    getValue:     function () { log("call", "SA.getValue"); return Promise.resolve(store); },
    updateValue:  function (v) { log("call", "SA.updateValue", v); store = v; return Promise.resolve(store); },
    onSetValue:   function (cb) { setValueCb = cb; return cb; },
    setContext: function (c) {
      log("call", "SA.setContext", c);
      if (c && typeof c === "object") window.SA_CONTEXT = c;
      return Promise.resolve(c);
    },
    setKeySchema: function (s2) { log("call", "SA.setKeySchema", s2); return Promise.resolve(s2); },
    isValid:      function () { return Promise.resolve(true); },

    // ---- status / role / permissions ----
    getItemStatus: function () { return Promise.resolve(F.statuses[0].status.name); },
    changeStatus:  function (t) { log("call", "SA.changeStatus", t); return Promise.resolve(t); },
    getAvailableTransitions: function () {
      return Promise.resolve(F.statuses.map(function (s2) { return s2.status.name; }));
    },
    getUserRole:     function () { return Promise.resolve(F.roles[0].name); },
    getPermissions:  function () { return Promise.resolve(F.permissions); },
    getTelemetryTime: function () { return Promise.resolve(0); },

    // ---- annotation ----
    // Resolves undefined on success; the real one rejects with an Error that
    // carries a .code, so failures here should be simulated the same way.
    saveAnnotation: function () { log("call", "SA.saveAnnotation"); return Promise.resolve(); },

    // ---- messaging ----
    dispatchEvent: function (t) { log("call", "SA.dispatchEvent", t); },
    postMessage:   function (t) { log("call", "SA.postMessage", t); },
    onMessage: function (fn) {
      messageHandlers.push(fn);
      return function () {
        var i = messageHandlers.indexOf(fn);
        if (i >= 0) messageHandlers.splice(i, 1);
      };
    },
    requestToPy: function (t) { log("call", "SA.requestToPy", t); return Promise.resolve(null); },
    onPyRequest: function (fn) {
      pyRequestHandlers.push(fn);
      return function () {
        var i = pyRequestHandlers.indexOf(fn);
        if (i >= 0) pyRequestHandlers.splice(i, 1);
      };
    },

    // ---- events ----
    on: function (name, fn, opts) {
      if (!SA_EVENTS[name]) throw new Error("Event " + name + " not found.");
      return addListener(SA_EVENTS[name], fn);
    },
    off: function (name, fn) {
      if (!SA_EVENTS[name]) throw new Error("Event " + name + " not found.");
      return removeListener(SA_EVENTS[name], fn);
    },
    onModalOpened: function (a, fn) { return addListener("listenModalOpened", fn); },
    onModalClosed: function (a, fn) { return addListener("listenModalClosed", fn); },

    // ---- chrome / navigation ----
    // reload and refreshPage are deliberately inert: honouring them would put
    // the local test page into a reload loop.
    openModal:   function (t) { log("call", "SA.openModal", t); },
    closeModal:  function (t) { log("call", "SA.closeModal", t); },
    navigateTo:  function (url, target) { console.log("[sa-stub] navigateTo (suppressed):", url, target); },
    refreshPage: function (bypass) { console.log("[sa-stub] refreshPage (suppressed), bypassCache =", bypass); },
    reload:      function () { console.log("[sa-stub] reload (suppressed)"); },
    postHeight:  function () {
      var r = document.documentElement.getBoundingClientRect();
      log("call", "SA.postHeight", Math.ceil(r.height));
    },
    showPushNotification: function (title, options) {
      console.log("[sa-stub] notification:", title, options || "");
    },
    logActivity: function (e) { log("call", "SA.logActivity", e); }
  });

  // Drive the host-side callbacks by hand from the console.
  window.SA_STUB = {
    emitMessage: function (data) { messageHandlers.slice().forEach(function (h2) { h2(data); }); },
    emitPyRequest: function (data) { return pyRequestHandlers.slice().map(function (h2) { return h2(data); }); },
    emitEvent: function (name, payload) {
      var ch = SA_EVENTS[name] || name;
      (listeners[ch] || []).slice().forEach(function (fn) { fn(payload); });
    },
    setValue: function (v) { store = v; if (setValueCb) setValueCb(v); },
    getStore: function () { return store; },
    events: SA_EVENTS
  };

  // Only presence is checked for SALIB (lines 75 and 592 of the bundle), but
  // it must exist or the module throws at import time.
  window.SALIB = window.SALIB || forgiving("SALIB", {});

  // ── window.SA_SDK ───────────────────────────────────────────────────────
  window.SA_SDK = forgiving("SA_SDK", {
    currentTeam:      function () { return Promise.resolve(F.team); },
    currentUser:      function () { return Promise.resolve(F.user); },
    currentProject:   function () { return Promise.resolve(F.project); },
    currentAsset:     function () { return Promise.resolve(F.asset); },
    // wrapper calls: getProject(id, { team_id }) and getProjects({ team_id, include_users })
    getProject:       function (id, params) { log("call", "SA_SDK.getProject", [id, params]); return Promise.resolve(F.project); },
    getProjects:      function (params) { log("call", "SA_SDK.getProjects", params); return Promise.resolve([F.project]); },
    getAssets:        function () { return Promise.resolve([F.asset]); },
    getFolders:       function () { return Promise.resolve([]); },
    getClasses:       function () { return Promise.resolve(F.classes); },
    workflowRoles:    function () { return Promise.resolve(F.roles); },
    workflowStatuses: function () { return Promise.resolve(F.statuses); },
    // SaSdkBase.signUrls() does: (await assetPathSign([key], t))[key].paths
    assetPathSign: function (keys) {
      var out = {};
      (keys || []).forEach(function (k) { out[k] = { paths: [F.asset.url] }; });
      return Promise.resolve(out);
    },
    getFileUrl:        function () { return Promise.resolve(F.asset.url); },
    uploadFile:        function () { return Promise.resolve({ uniqueName: "local-upload", path: F.asset.url }); },
    createConversation: function () { return Promise.resolve({ id: 1 }); },
    // SaSdkBase calls this as authorizedRequest(baseUrl, path, options) for
    // five different platform endpoints, each with its own response shape.
    // Consumers accept either a Response (with .json()) or a plain object, so
    // plain objects are returned here.
    authorizedRequest: function (baseUrl, path, options) {
      var url = String(baseUrl || "") + String(path || "");
      log("call", "SA_SDK.authorizedRequest", [url, options && options.method]);
      // getCategories(): -> { data: [...] } -> toCategory()
      if (/\/categories/.test(url)) return Promise.resolve({ data: F.categories });
      // getStatusChangeRules(): -> .data.raw_config
      if (/\/workflows\//.test(url)) return Promise.resolve({ data: { raw_config: F.workflowRawConfig } });
      // getTeamProxies(): -> .results [{id, name}]
      if (/\/proxies/.test(url)) return Promise.resolve({ results: F.proxies });
      // getItems(): the raw search result is returned as-is
      if (/\/items\/search/.test(url)) {
        return Promise.resolve({ data: [F.asset], count: 1, offset: 0, limit: 50 });
      }
      // unassignItemFromMyself()
      if (/editAssignment/.test(url)) return Promise.resolve({ ok: true });
      log("UNROUTED", "authorizedRequest " + url);
      return Promise.resolve({ data: null });
    },
    proxiedRequest:    function (a, b) { log("call", "SA_SDK.proxiedRequest", [a, b]); return Promise.resolve(null); }
  });

  console.log(
    "%c[sa-stub]%c installed — SA, SALIB, SA_SDK, SA_CONTEXT. " +
      "Set window.SA_STUB_VERBOSE = true before the module loads to log every call. " +
      "Edit window.LOCAL_FIXTURE in local-sa-stub.js for your own image/classes.",
    "color:#7c5cff;font-weight:700", ""
  );
})();
