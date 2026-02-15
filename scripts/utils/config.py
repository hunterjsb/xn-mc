import os
from functools import cache
from typing import AnyStr

from dotenv import load_dotenv


class Config:
    LOADED = False

    def __init__(self, throw_error=True):
        self.throw_error = throw_error
        if not Config.LOADED:
            env_path = os.path.join(os.path.dirname(__file__), '..', '..', '.env')
            print('loading dotenv...', load_dotenv(env_path))
            Config.LOADED = True

    @cache
    def __getitem__(self, item):
        return os.environ[item] if self.throw_error else os.getenv(item)

    @property
    def world_filepath(self) -> AnyStr:
        return os.path.join(self['SERVER_FP'], self.world_name)

    @property
    def world_name(self) -> str:
        return self['WORLD_NAME']
