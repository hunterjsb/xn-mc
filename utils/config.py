import os
from functools import cache
import zipfile
from typing import AnyStr

from dotenv import load_dotenv


class Config:
    LOADED = False

    def __init__(self, throw_error=True):
        self.throw_error = throw_error
        if not Config.LOADED:
            load_dotenv()
            Config.LOADED = True

    @cache
    def __getitem__(self, item):
        return os.environ[item] if self.throw_error else os.getenv(item)

    @property
    def world_filepath(self) -> AnyStr:
        return os.path.expanduser(self['MC_WORLD_PATH'])

    @property
    @cache
    def world_name(self) -> str:
        return os.path.basename(os.path.normpath(self.world_filepath))
