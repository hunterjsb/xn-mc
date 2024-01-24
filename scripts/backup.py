import os
import zipfile
from typing import AnyStr

import boto3

from utils.config import Config


def upload_file_to_s3(zip_fp: str, bucket: str, key: str):
    s3_client = boto3.client('s3')
    s3_client.upload_file(zip_fp, bucket, key)
    return f'https://{bucket}.s3.amazonaws.com/{key}'


def zip_world(world_fp: AnyStr, output_file_name: str):
    # Determine the parent directory
    parent_dir = os.path.dirname(world_fp)
    output_fp = os.path.join(parent_dir, output_file_name + '.zip')

    # Create a ZipFile object in write mode
    with zipfile.ZipFile(output_fp, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Walk through the directory
        for root, dirs, files in os.walk(world_fp):
            for file in files:
                # Create a proper path relative to the folder being zipped
                file_path = os.path.join(root, file)
                file_path_in_zip = os.path.relpath(file_path, world_fp)
                # Add the file to the zip file
                zipf.write(file_path, file_path_in_zip)

    return output_fp


if __name__ == '__main__':
    import sys

    cfg = Config()
    log_file_path = os.path.expanduser(cfg['LOG_FILE_PATH'])

    with open(log_file_path, 'a') as log_file:
        sys.stdout = log_file
        sys.stderr = log_file

        zipped_to = zip_world(cfg.world_filepath, cfg.world_name)
        print(f'Zipped world to {zipped_to}')

        bucket_url = upload_file_to_s3(zipped_to, cfg['S3_BUCKET'], cfg.world_name + '.zip')
        print(f'World backed up to {bucket_url}')
