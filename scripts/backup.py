import os
import zipfile
import boto3
import argparse
from utils.config import Config


def upload_file_to_s3(zip_fp: str, bucket: str, key: str):
    s3_client = boto3.client('s3')
    s3_client.upload_file(zip_fp, bucket, key)
    return f'https://{bucket}.s3.amazonaws.com/{key}'


def zip_world(world_fp: str, output_file_name: str):
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


def download_file_from_s3(bucket: str, key: str, download_fp: str):
    s3_client = boto3.client('s3')
    print('trying to download ', bucket, key.strip('/'), download_fp)
    s3_client.download_file(bucket, key.strip('/'), download_fp)


def unzip_file(zip_fp: str, extract_dir: str):
    with zipfile.ZipFile(zip_fp, 'r') as zip_ref:
        zip_ref.extractall(extract_dir)


def main(_args):
    cfg = Config()
    if _args.command == 'upload':
        zipped_to = zip_world(cfg.world_filepath, cfg.world_name)
        print(f'Zipped world to {zipped_to}')
        bucket_url = upload_file_to_s3(zipped_to, cfg['S3_BUCKET'], cfg.world_name + '.zip')
        print(f'World backed up to {bucket_url}')

    elif _args.command == 'download':
        download_fp = os.path.join(cfg.world_filepath + '.zip')
        print(download_fp)
        download_file_from_s3(cfg['S3_BUCKET'], '/' + cfg.world_name + '.zip', download_fp)
        print(f'World downloaded to {download_fp}')
        unzip_file(download_fp, cfg.world_filepath)
        print(f'World extracted to {cfg.world_filepath}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Minecraft World Backup and Restore Utility')
    parser.add_argument('command', choices=['upload', 'download'], help='The command to execute (upload or download)')
    args = parser.parse_args()

    main(args)
