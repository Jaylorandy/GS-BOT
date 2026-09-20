#!/usr/bin/env python3
"""
SMB Client Helper for LAN Drive
Used by Electron main process to connect to SMB shares
"""
import sys
import os
import json
from smb.SMBConnection import SMBConnection

def list_shares(host, username, password, client_name, server_name):
    """List available shares"""
    try:
        conn = SMBConnection(username, password, client_name, server_name, use_ntlm_v2=True)
        if conn.connect(host, 445):
            shares = conn.listShares()
            result = [s.name for s in shares if not s.name.endswith('$')]
            conn.close()
            return {'success': True, 'shares': result}
        conn.close()
        return {'success': False, 'error': 'Connection failed'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def list_dir(host, username, password, client_name, server_name, share, path):
    """List files in a directory"""
    try:
        conn = SMBConnection(username, password, client_name, server_name, use_ntlm_v2=True)
        if conn.connect(host, 445):
            # 使用原始的 share 名称（可能是中文）
            share_name = share.encode('utf-8').decode('utf-8')
            
            path = path.lstrip('/')
            if not path:
                path = '*'
            else:
                path = path.replace('/', '\\') + '\\*'
            
            files = conn.listPath(share_name, path)
            entries = []
            for f in files:
                if f.filename in ['.', '..']:
                    continue
                entries.append({
                    'name': f.filename,
                    'type': 'directory' if f.isDirectory else 'file',
                    'size': f.fileSize if hasattr(f, 'fileSize') else 0,
                    'modified': f.lastWriteTime.strftime('%Y-%m-%d') if hasattr(f, 'lastWriteTime') and f.lastWriteTime else ''
                })
            conn.close()
            return {'success': True, 'entries': entries}
        conn.close()
        return {'success': False, 'error': 'Connection failed'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

def download_file(host, username, password, client_name, server_name, share, remote_path, local_path):
    """Download a file"""
    try:
        conn = SMBConnection(username, password, client_name, server_name, use_ntlm_v2=True)
        if conn.connect(host, 445):
            remote_path = remote_path.lstrip('/').replace('/', '\\')
            with open(local_path, 'wb') as f:
                conn.retrieveFile(share, remote_path, f)
            conn.close()
            return {'success': True, 'localPath': local_path}
        conn.close()
        return {'success': False, 'error': 'Connection failed'}
    except Exception as e:
        return {'success': False, 'error': str(e)}

if __name__ == '__main__':
    args = json.loads(sys.argv[1])
    action = args.get('action')
    
    host = args.get('host')
    username = args.get('username', '')
    password = args.get('password', '')
    client_name = args.get('clientName', 'MacBook-Pro')
    server_name = args.get('serverName', 'WORKGROUP')
    
    if action == 'list_shares':
        result = list_shares(host, username, password, client_name, server_name)
    elif action == 'list_dir':
        share = args.get('share')
        path = args.get('path', '/')
        result = list_dir(host, username, password, client_name, server_name, share, path)
    elif action == 'download':
        share = args.get('share')
        remote_path = args.get('remotePath')
        local_path = args.get('localPath')
        result = download_file(host, username, password, client_name, server_name, share, remote_path, local_path)
    else:
        result = {'success': False, 'error': f'Unknown action: {action}'}
    
    print(json.dumps(result, ensure_ascii=False))
