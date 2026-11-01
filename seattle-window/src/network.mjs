import * as http from 'node:http';

// Node's fetch does not use HTTP(S)_PROXY by default. Use the native proxy
// support when available so managed environments keep their routing and trust.
export function configureNetwork({env=process.env,setProxyFromEnv=http.setGlobalProxyFromEnv}={}) {
  const proxyConfigured=!!(env.http_proxy||env.HTTP_PROXY||env.https_proxy||env.HTTPS_PROXY);
  const proxySupported=typeof setProxyFromEnv==='function';
  if(!proxyConfigured)return {mode:'direct',proxyConfigured,proxySupported,restore:()=>{}};
  if(!proxySupported){
    const error=new Error('This environment requires an HTTP(S) proxy. Use Node.js 24.19 or newer to connect the live data feeds.');
    error.code='PROXY_UNSUPPORTED';throw error;
  }
  // Local app requests must stay local; retain all existing bypass rules and
  // the lowercase-variable precedence used by Node's proxy implementation.
  const noProxy=[env.no_proxy||env.NO_PROXY,'localhost','127.0.0.1','[::1]'].filter(Boolean).join(',');
  try{
    const restore=setProxyFromEnv({...env,no_proxy:noProxy,NO_PROXY:noProxy});
    return {mode:'proxy',proxyConfigured,proxySupported,restore};
  }catch{
    // Native configuration errors can include the proxy URL and its password.
    const error=new Error('Invalid HTTP(S) proxy configuration. Check HTTP_PROXY, HTTPS_PROXY and NO_PROXY in the environment.');
    error.code='PROXY_INVALID';throw error;
  }
}
